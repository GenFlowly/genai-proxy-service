# Genai Proxy Server - Development Guide

## Dependency Injection (Koin)

We use Koin for dependency injection. All shared resources and services should be registered in `src/main/kotlin/di/Modules.kt`.

### HTTP Client Guidelines

We have a centralized, resilient Ktor `HttpClient` configured in the Koin module. This shared client comes pre-configured with:
- **Exponential Backoff:** Up to 3 retries for server errors (500, 502, 503, etc.).
- **Global Timeouts:** 60 seconds default.
- **Content Negotiation:** Kotlinx JSON serialization.

**DO NOT instantiate your own `HttpClient` inside a service class.** Instead, request the shared client via your class constructor. 

#### Example: Creating a new Service

**1. Ask for `HttpClient` in the constructor:**
```kotlin
package com.genflowly.service

import io.ktor.client.HttpClient
import io.ktor.client.request.post

class MyNewService(
    private val httpClient: HttpClient // <-- Inject the shared client
) {
    suspend fun callExternalApi() {
        // This call automatically inherits retries, timeouts, and JSON serialization
        httpClient.post("https://api.example.com")
    }
}
```

**2. Register it in `Modules.kt`:**
```kotlin
// Inside src/main/kotlin/di/Modules.kt
fun appModule(): Module = module {
    // ... other dependencies ...
    
    // Koin's get() automatically grabs our shared HttpClient and injects it
    single { MyNewService(get()) } 
}
```

By following this pattern, all network calls across the backend remain highly resilient and centrally manageable.

## Authentication (API / Activities)

When creating new authenticated routes in Ktor (`Activity` files), you must ensure that the incoming requests are properly authenticated and that you correctly retrieve the user's `customerId`.

### Retrieving `customerId`

Do **NOT** attempt to parse the `customerId` directly as a custom claim from the Auth0 JWT. The JWT typically only contains the user's Auth0 `sub` (subject), and the actual `customerId` must be looked up in DynamoDB.

To simplify this, use the `requireAuthenticatedCustomerId` extension function on `ApplicationCall`, which handles extracting the `sub` and calling the `CustomerProfileService` dynamically.

**1. Inject `CustomerProfileService` into your Route:**

> Note: this snippet is simplified for the auth flow. Real routes must also carry an OpenAPI
> documentation block — see [API Documentation (OpenAPI / Swagger)](#api-documentation-openapi--swagger) below.

```kotlin
fun Route.registerMyNewRoutes(customerProfileService: CustomerProfileService) {
    // Protect the route with Auth0
    authenticate("auth0") {
        post("/api/v1/my-new-endpoint") {
            // This safely retrieves the customerId, or responds with 401/403 if invalid
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            
            // Proceed with your logic using customerId
            call.respond(HttpStatusCode.OK)
        }
    }
}
```

**2. Don't forget to import the utility:**
```kotlin
import com.genflowly.utils.requireAuthenticatedCustomerId
```

If you only need to check if a user is authenticated without forcing an error response, you can use `call.getAuthenticatedCustomerId(customerProfileService)` which returns a nullable `String?`.

### Developer API keys (second auth method)

Besides Auth0 JWTs, customers can authenticate with developer API keys (`gfy_...`), created in the web app under Settings → Developer and sent the same way (`Authorization: Bearer gfy_...`). The `"apiKey"` bearer provider in `Application.kt` resolves them via `DeveloperApiKeyService` (SHA-256 hash lookup in the `CustomerDeveloperApiKeys` table; the key itself is stored KMS-encrypted).

- **Data-plane routes** should accept both methods: `authenticate("auth0", "apiKey") { ... }`. `requireAuthenticatedCustomerId` / `getAuthenticatedCustomerId` handle both principal types transparently.
- **Web-app-only routes** (onboarding, profile, user search, notes, and the key-management endpoints themselves) stay `authenticate("auth0")` and should say "Web-app only" in their OpenAPI description.
- The key-management endpoints (`/api/v1/developer/api-keys`) are marked `hidden = true` — keep them out of the public spec.

## API Documentation (OpenAPI / Swagger)

The OpenAPI spec is **generated from code at runtime** by the [Smiley4 ktor-openapi](https://github.com/SMILEY4/ktor-openapi-tools) plugin (installed in `Application.kt`). There is no separate YAML file to maintain and no codegen step:

- Spec (JSON): `http://localhost:8080/api.json`
- Swagger UI (internal/dev): `http://localhost:8080/swagger` (redirects to `/swagger/index.html`)
- Scalar (customer-facing docs): `http://localhost:8080/docs` — served from `src/main/resources/docs/index.html`, loads the [Scalar](https://github.com/scalar/scalar) bundle from jsdelivr and reads `/api.json`. The `/docs` route itself is marked `hidden = true` so it stays out of the spec.

JSON schemas are derived automatically from the `@Serializable` request/response data classes referenced in the route documentation — never hand-write a schema.

### Checklist when adding a new API in `activity/`

**1. Import the documented route builders — not Ktor's.**

The documentation DSL only works with the route builders from `io.github.smiley4.ktoropenapi`. If you import `io.ktor.server.routing.get/post/put/delete`, the route still works but silently disappears from the spec.

```kotlin
import io.github.smiley4.ktoropenapi.get     // ✅
import io.github.smiley4.ktoropenapi.post    // ✅
// import io.ktor.server.routing.post        // ❌ route won't be documented
```

(`io.ktor.server.routing.Route` is still needed for the `fun Route.registerXxxRoutes` receiver — only the method builders change.)

**2. Define request/response DTOs as `@Serializable` data classes** in `models/api/` (package `com.genflowly.models.api`). For error and status payloads, reuse the shared doc models from `models/api/CommonResponses.kt` instead of creating new ones:

- `ErrorResponse` — for `mapOf("error" to ...)` responses
- `StatusResponse` — for `mapOf("status" to "success")` responses
- `SuccessResponse` — for `mapOf("success" to true)` responses

**3. Add the documentation block** as the second argument to the route builder, before the handler lambda:

```kotlin
fun Route.registerMyNewRoutes(customerProfileService: CustomerProfileService) {
    authenticate("auth0") {
        post("/api/v1/my-new-endpoint", {
            tags("MyGroup")                      // groups the endpoint in Swagger UI
            summary = "One-line summary"
            description = "Longer explanation of behavior, side effects, preconditions."
            request {
                pathParameter<String>("id") { description = "..." }      // for {id} in path
                queryParameter<Int>("pageSize") {                        // for query params
                    description = "..."
                    required = false
                }
                body<MyNewRequest> {                                     // JSON request body
                    description = "..."
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "What a success returns"
                    body<MyNewResponse>()
                }
                code(HttpStatusCode.BadRequest) {
                    description = "When/why this happens"
                    body<ErrorResponse>()
                }
                code(HttpStatusCode.InternalServerError) {
                    description = "Unexpected server error"
                    body<ErrorResponse>()
                }
            }
        }) {
            // handler exactly as before
            val customerId = call.requireAuthenticatedCustomerId(customerProfileService)
            call.respond(HttpStatusCode.OK)
        }
    }
}
```

Document every status code the handler can actually respond with (including the error branches in `catch` blocks) — the spec is only as truthful as this block.

**4. Authentication is picked up automatically.** Routes inside an `authenticate("auth0") { }` block are marked as protected with the `auth0` bearer scheme in the spec — no per-route security config needed. For `authenticate("auth0", optional = true)` routes, mention the unauthenticated behavior in the `description`.

**5. Register the route in `Routing.kt`** (same as always). Nothing extra is needed for the docs — the plugin discovers routes from the routing tree.

**6. Verify.** Start the server, open `/swagger`, and check the new endpoint: correct tag, request/response schemas render, and the lock icon shows for authenticated routes. Existing tag names are defined in `Application.kt` (`Generation`, `Conversations`, `Instructions`, `Customer`, `Tool Credentials`, `Agents`, `Notes`); if you introduce a new tag, add it there with a description so it renders properly in Swagger UI.

### Special cases

- **Path parameters** come from the route path (`{graphId}`) but still need a matching `pathParameter<T>("graphId")` entry to get a description and type in the docs.
- **Streaming/non-JSON responses**: document the media type and any metadata headers explicitly, e.g.:

```kotlin
code(HttpStatusCode.OK) {
    description = "Plain-text stream of generated chunks"
    body<String> { mediaTypes(ContentType.Text.Plain) }
    header<String>("X-Conversation-Id") { description = "..." }
}
```

See `activity/generation/GenerateTextStreamActivity.kt` for a complete example, or any existing activity file for the standard pattern.

## Observability — metrics & logging conventions

All services follow ONE set of metric-naming and dimension conventions, pinned here and implemented for Python in `encoding-library/src/encoding_library/observability/`. Dashboards and alarms live in Grafana (fed by Fly Prometheus for the Fly apps and CloudWatch for the lambdas), so a metric must mean the same thing no matter which service emitted it.

### Metric naming

- `snake_case`. Counters end in `_total`; duration histograms end in `_duration_seconds` (seconds, not ms).
- One operation = one counter + one duration histogram, e.g. `web_search_total{status=...}` + `web_search_duration_seconds`.
- `status` values: `ok` | `error` (plus operation-specific values like `missing_key` where meaningful).

### Dimensions (labels)

Only these dimension keys are allowed: `operation`, `status`, `vendor`, `model`, `data_type`, `tool`, `direction`, `source` (+ an automatic `service`). The Python util silently drops anything else.

**Never add `customer_id` (or any per-customer / per-request value) as a metric dimension.** Per-customer label values explode Prometheus series cardinality and CloudWatch per-metric billing. Customer context belongs in *logs* (structured field + request id), not metrics — per-customer cost/usage questions are answered from DynamoDB, not from dashboards.

### Canonical metrics (emit these names, don't invent variants)

| Metric | Dimensions | Emitted by |
|---|---|---|
| `llm_request_total` / `llm_request_duration_seconds` | vendor, model, status | retrieval-server LLM nodes |
| `llm_tokens_total` | vendor, model, direction (`input`\|`output`\|`cache_read`\|`cache_creation`) | retrieval-server LLM nodes |
| `llm_cost_usd_total` | vendor, model | **Kotlin proxy (Micrometer pass, pending)** |
| `vector_store_total` / `_duration_seconds` | status | store_embeddings lambda |
| `vector_store_chunks_total` | data_type | store_embeddings lambda |
| `vector_store_ddb_writeback_failure_total` | data_type | store_embeddings lambda |
| `create_embeddings_total` / `_duration_seconds`, `embedding_chunks_total` | status | create_embeddings lambda |
| `vector_retrieval_total` / `_duration_seconds` | status, source (`retrieve`\|`search`) | retrieval-server |
| `embedding_failure_total` | source, model | retrieval-server |
| `zilliz_credential_fallback_total` | — | encoding-library (both runtimes) |
| `web_search_total` / `_duration_seconds` | status | retrieval-server |
| `tool_execution_total` / `_duration_seconds` | tool, status | retrieval-server TOOL_EXECUTOR |
| `stream_zero_tokens_total`, `stream_error_total` | vendor | retrieval-server streaming |

### Python services (retrieval-server, encoding lambdas)

Use the shared util — decorator for the ok/error/duration triple, imperative calls for values produced inside the operation:

```python
from encoding_library.observability import track, count, observe, setup_logging, configure_observability

configure_observability(service="retrieval-server", backend="prometheus")  # lambdas auto-detect EMF
setup_logging("retrieval-server")  # JSON lines + contextvar request_id

@track("vector_store", data_type="note")     # -> vector_store_total + vector_store_duration_seconds
def store(...): ...

count("vector_store_chunks_total", len(chunks), data_type="NOTE")
observe("llm_request_duration_seconds", elapsed, vendor=provider)
```

When an operation *swallows* its failures by design (graph nodes that degrade to empty results), put `@track` on a raising inner function and catch around the call — a metric that can never record `status=error` is useless for alarming. See `graph/nodes/retrieval.py` / `web_search.py` for the pattern.

Logging: emit structured context via `extra={...}` (rendered as JSON fields), not f-string interpolation, for anything a dashboard or Logs Insights query might filter on. Never rely on log-message wording for alarms — that's what the counters are for.

### Kotlin proxy (future Micrometer pass)

The proxy can't use the Python util — when metrics are added there (Micrometer + Prometheus registry, scraped by Fly the same way), **follow the exact metric names and dimension keys above**. Specifically:

- LLM **cost**: emit `llm_cost_usd_total{vendor, model}` as a float counter at the three `CostCalculationService.computeCostUsd` call sites (`GenerationOrchestrator` non-streaming + streaming, `VoiceSessionService`). Until then, cost dashboards are *derived* from the retrieval-server's `llm_tokens_total` × static rates and are approximate.
- Micrometer's `Counter.increment(double)` and `Timer` map 1:1 to the conventions; name timers `*_duration_seconds` via `DistributionSummary`/`Timer` with base-unit seconds.
