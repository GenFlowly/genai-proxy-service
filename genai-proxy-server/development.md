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

## Default actions (request-agent registry)

An **action** is an internal generation flow the server runs on the user's behalf — not a chat turn the user typed. Current actions: instruction-persona creation, conversation-title generation, note-title generation, and memory extraction ("Learn about User"). Each action resolves the agent (prompt + model + optional graph) that serves it at call time instead of hardcoding prompts.

### Where things live

- **Registry**: the `RequestType` enum (`models/RequestType.kt`) is the single source of truth. Each value carries a `displayName` and the `templateVariables` the server supplies to that action's prompts. Both admin panel and react app render actions straight from this registry via the map APIs — nothing action-specific is hardcoded client-side (the clients keep only fallback labels).
- **Bundled defaults**: `resources/config/request-agent-defaults.json` + prompt files under `resources/config/prompts/`. This is what serves an action when no DDB mapping exists.
- **Mappings**: the `RequestAgentMap` DDB table, keyed `(scope, requestType) → graphId`. Two scopes:
  - `SYSTEM` — the global default, managed in the admin panel ("Default Actions Mapping" page, `RequestAgentMapAdminService`). Mapping a graph transfers it to System ownership.
  - `<customerId>` — a per-user override, managed from the react app's Settings → Default Actions (`CustomerRequestAgentMapService`, `/api/v1/request-agents`). No ownership transfer; the user maps their own agents.
- **Resolution**: `AgentResolutionService.resolve(requestType, customerId)` — customer scope → `SYSTEM` scope → bundled default, cached ~60s per (scope, requestType). Execution goes through `GenerationAgentExecutor` on the **customer's** AI keys; multi-node graphs run on the retrieval-server LangGraph runtime.
- Note: the customer-chat **default agent is NOT an action** — chat serves the System graph flagged `isDefault=true` directly and never goes through this map.

### Adding a new action

1. Add the enum value to `RequestType` **with its `displayName` and `templateVariables`** — the admin panel's mapping page and the react app's Settings section pick it up automatically from the registry; no client change needed.
2. Add its bundled default to `request-agent-defaults.json` (mapKey, outputFormat, modelPreference, maxTokens) and its prompt files under `config/prompts/` (`{{var}}` placeholders must match the registry's `templateVariables`).
3. At the call site, resolve with `agentResolutionService.resolve(RequestType.NEW_ACTION, customerId)` and execute via `GenerationAgentExecutor.executeWithCustomerKey(...)`, passing exactly the registered variables.
4. Template syntax caveat: the local single-call path renders `{{var}}` (`PromptTemplateRenderer`); the LangGraph path substitutes single-brace `{var}` in node prompts (`retrieval-server/routes/retrieve.py`). Agents built in the UI should use single-brace placeholders in their input templates.
5. Emit the standard metrics for the new flow (see Observability below) and never log prompt content in production.

## Retention: tagged objects, the kept-object claim and customer deletion

Customer files live in the private attachments bucket `gen-ai-proxy-service-{stage}-attachments`, under `customers/{customerId}/`. The rule every writer follows: an object is either **linked** from a DynamoDB row (and deleted by the purge when its customer is deleted, unless a kept shared conversation still links it) or **tagged to expire**. Nothing may be both unlinked and permanent.

### Keys and tags

| Object | Written by | Tag at write |
|---|---|---|
| `customers/{cid}/attachments/{id}`: browser uploads | the browser, PUT to the URL from `POST /api/v1/attachments` | `retention=pending` when the request sends `tagging: true` or the file is a PDF. The tag is signed into the URL, so the client must send the response's `requiredHeaders` (`x-amz-tagging`) with the PUT |
| `customers/{cid}/attachments/{id}` + `{key}.source.md`: generated artifacts (PDFs) | retrieval-server `save_artifact` | `retention=pending` |
| `{key}.derived/...`: regenerable sidecars | retrieval-server | `retention=derived` |
| `customers/{cid}/agent-fs/{namespace}/...`: agent scratch, oversized tool output | retrieval-server `fs_write`, tool executor spill | `retention=scratch` |

When a message row links an object, the claim (below) retags it `retention=kept` + `conv={conversationId}`. Uploads from old clients that send no `tagging` are untagged: no rule expires them, and an account deletion's sweep removes them.

### Lifecycle rules (genai-proxy-server-cdk `lib/s3-stack.ts`)

| Rule | Matches | Action |
|---|---|---|
| `expire-scratch` | tag `retention=scratch` | expire 7 days after creation |
| `expire-derived` | tag `retention=derived` | expire 30 days after creation |
| `expire-pending` | tag `retention=pending` | expire 7 days after creation. **Created disabled**, see the rollout order |
| `abort-incomplete-multipart-uploads` | every key | abort after 1 day |

No rule matches `retention=kept` or an untagged object (a CDK test asserts it). Expiry counts from the object's creation, not from when it was tagged, so enabling the pending rule deletes at once every pending object older than 7 days.

The bucket is deliberately **unversioned**: a purge delete must remove the bytes, not add a delete marker. The CDK sets `versioned: false` and a test asserts it, but the live state of both stages must be checked (not yet recorded):

```
aws s3api get-bucket-versioning --bucket gen-ai-proxy-service-development-attachments
aws s3api get-bucket-versioning --bucket gen-ai-proxy-service-production-attachments
```

Empty output means the bucket was never versioned, which is what the purge needs. `"Status": "Enabled"` or `"Suspended"` means deleted objects survive as noncurrent versions: fix that before relying on the purge.

### The kept-object claim (`service/ObjectClaimService.kt`)

`ConversationService.addMessageInConversation` claims every object a message links, before `createMessage`:

- **Linked keys**: each attachment's `s3Key` and `sourceKey` (an assistant row without `sourceKey` also gets its legacy `{s3Key}.source.md`, when it exists) and every `s3_key` image in `toolResultsJson`. A key must match `^customers/[^/]+/(attachments|agent-fs)/`; any other is skipped and logged by attachment id only.
- A pending or untagged object is retagged `retention=kept`, `conv={conversationId}`. One already kept for this conversation is left as is.
- An object kept for **another** conversation (a message copied or forked across conversations) is copied to `customers/{owner of the original}/attachments/{newId}`, tagged kept for this conversation, and the row links the copy under the same attachmentId; a PDF's `.source.md` sidecar is copied with it. `newId` is derived from the messageId and the original key, so retries reuse the same copy.
- A missing object is skipped and counted.
- Up to 8 objects in parallel, 4 attempts each. If an object still fails, the row is written anyway with `claimPending = 1`, which puts it in the Message table's sparse `claimPendingIndex`.
- If `createMessage` fails, the objects this write claimed go back to `pending`. When a write replaces a row (edit, regenerate), the keys only the old row linked go back to `pending`, unless another message still links them.
- **Write guard**: the write is refused when the Conversation row is missing or its purge has started (`purgeStartedAt`). The turn's objects stay pending and expire.

`ClaimReconciler` runs every 5 minutes (first run 1 minute after start-up). It re-claims the 100 oldest `claimPending` messages and clears the flag once a claim is complete. A message still pending after 3 days logs an ERROR and counts `retention_claim_overdue_total`: fix it before the pending rule expires its objects at 7 days.

### Backfill (once per stage)

Rows written before the claim went live link objects that are still pending or untagged. The admin-only (`ADMIN_EMAILS`) backfill claims them:

```
curl -X POST "$PROXY_URL/api/v1/admin/retention/claim-backfill" \
  -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"maxItems": 1000}'
# repeat with {"pageToken": "<nextPageToken from the last response>", "maxItems": 1000} until "done": true
```

Each call scans one page of the Message table (`maxItems` 1 to 1,000, default 200) at about 20 messages per second and returns `scannedMessages`, `messagesWithFiles`, `claimedMessages`, `pendingMessages`, `copiedObjects`, `vanishedMessages`, `nextPageToken` and `done`. It is idempotent: if a call fails, repeat it with the same `pageToken`. A message it cannot finish gets `claimPending` and the reconciler takes over.

### Rollout order (per stage, development first)

1. **Deploy** (CI): the CDK changes (lifecycle rules with the pending rule disabled, the IAM split, PurgeJobs, the Message `claimPendingIndex`) and the proxy with the claim and the reconciler. The retrieval server and the react app that tag `pending` ship in the same release.
2. **Backfill** the stage until `done: true`, once step 1 is live there.
3. **Message `customerIdIndex`**: CloudFormation adds one GSI per table update, so `cdk.json` pins `"messageGsiPhase": "1"` (only `claimPendingIndex`). After both stages have deployed step 1, a commit that removes the pin adds `customerIdIndex`. Account deletion needs it: until then its jobs fail at the sweep and retry. Do not merge the removal to `main` in the same push as step 1, because production would try to add both indexes and the deploy would fail (CloudFormation rolls it back).
4. **Enable the pending rule**: a commit that sets `"enablePendingExpiry": true` in `cdk.json`. Do this only after the claim is live in production, the backfill has finished in both stages, and nothing in `claimPendingIndex` is overdue.
5. **Record** the live versioning state of both buckets (above).

Change both pins in `cdk.json`, in a commit. A one-off `cdk deploy -c ...` is undone by the next CI deploy, and for the index pin that means the index is deleted.

### IAM: one AWS user per Fly app (genai-proxy-server-cdk `lib/flyio-iam-stack.ts`)

| IAM user (stack outputs → Fly app) | Attachments bucket | Other grants |
|---|---|---|
| `gen-ai-proxy-service-{stage}-flyio-user` (`ProxyAwsAccessKeyId`/`ProxyAwsSecretAccessKey` → proxy server; the user both apps used to share) | Get/Put on every key; PutObjectTagging, GetObjectTagging, DeleteObject on `customers/*`; ListBucket | ListBucketVersions + DeleteObjectVersion on `genflowly-{stage}-customer-documents`; DynamoDB; KMS; lambda:InvokeFunction |
| `gen-ai-proxy-service-{stage}-retrieval-flyio-user` (`RetrievalAwsAccessKeyId`/`RetrievalAwsSecretAccessKey` → retrieval server) | Get/Put on every key; PutObjectTagging on `customers/*`; ListBucket | DynamoDB; KMS. **No S3 delete of any kind** |

ListBucket makes a missing key read as 404/NoSuchKey instead of AccessDenied, and serves listings (the purge's `listKeys`, the agent's `fs_list`). The deploy workflows read each pair from the `gen-ai-proxy-service-FlyioIamStack` outputs and set it on its own Fly app.

### Customer deletion (plan 3.9)

Deletion is admin-only (`ADMIN_EMAILS`). There is no self-service route, and an admin cannot delete their own account this way.

- `DELETE /api/v1/admin/customers/{customerId}` returns 202 with the job status. Repeating it returns the same job. (The path id follows the deletion contract; it is an exception to the query-parameter rule under Observability.)
- `GET /api/v1/admin/customers/deletion?customerId=` returns the job status: state, stage, attempts, warnings, last error, and conversation purges done out of total.

**Account job** (`service/AccountDeletionService.kt`; row `ACCOUNT#{customerId}` in PurgeJobs). It resumes after its last completed stage:

1. **Stop writes.** Delete the developer API keys, and delete the Auth0 user through the Management API. The Auth0 user is kept, with a warning on the job, when the Management API is not configured, the login is unknown, or the login also holds another account.
2. **Rename.** In one TransactWriteItems, the CustomerProfile row is re-keyed to `sub = DELETED#{customerId}` with name "Deleted User", and the username stays. The UsernameLookup row is deleted. Then the customer's in-flight turns are cancelled, and the job waits up to 2 minutes for them to end (`InFlightTurns`).
3. **Classify** the owned conversations, archived ones included. A conversation with any SharedConversations row (PUBLIC included) is kept, and shows the owner as "Deleted User". Every other one gets a conversation purge job.
4. **Sweep.** The keep set is every key linked from the kept conversations and from the customer's messages in other people's conversations (Message `customerIdIndex`). Every other object under `customers/{customerId}/` is deleted: unsent uploads, scratch and orphans.
5. **Delete the rest**:
   - the run data of the kept messages (retrieval-server `DELETE /runs/{run_id}/data`), then every other durable run whose input is the customer's, found on the retrieval-server by listing its workflows (`DELETE /customers/{customerId}/run-data`: rows written before `runId` was stored, request agents the run sweep has not reached), with the customer's tool-ledger rows. A run that may still execute is cancelled and the answer is 409, so the job retries;
   - the customer's recipient share rows. A deleted owner's conversation left without any share is purged;
   - instructions, except those a System agent's node references through `instruction_id` or `harness_instruction_id`, at any depth of the node config (warning `instructions_kept`);
   - agent graphs and nodes (every version) and the shares of all of these;
   - RequestAgentMap overrides and every customer-keyed table;
   - the `{customerId}_*` vector collections (encoding-server `POST /purge-vectors`) and CustomerVectorDBConfig;
   - every object version under `{customerId}/` in `genflowly-{stage}-customer-documents`.
6. **Wait** until its conversation purges are DONE, then finish.

**Conversation purge** (`service/ConversationPurgeService.kt`; the row is keyed by the conversationId):

1. Set `purgeStartedAt`, which arms the write guard.
2. Settle the `pendingRuns`: record each run id; remove runs that are terminal or unknown (404); cancel active runs and retry the job in 5 minutes. After 6 such waits, each one counts as a failed attempt.
3. Delete the conversation's objects: the exact keys, plus the `.derived/` and scratch prefixes. An object kept for another conversation is never deleted.
4. Delete the run data, and the conversation's vectors from every participant's collections.
5. Delete the Message rows and re-read to check none is left. Then delete the shares, the memory META rows, InstructionUsageSeen, and the Conversation row last. If the job crashes before this step, the rows still link everything it needs to re-run.

Archive and unarchive purge nothing. Archiving or unsharing a conversation enqueues its purge only when its owner has an `ACCOUNT#` job and no share row remains: nobody can open such a conversation again.

**Worker** (`service/PurgeJobWorker.kt`): polls every minute for up to 10 due jobs, under a 15-minute lease. A failed attempt backs off from 1 minute, doubling, up to 6 hours. From the 10th attempt, every failure logs an ERROR and counts `purge_jobs_total{status="stuck"}`.

**Configuration** (proxy environment, all optional):

| Variable | Purpose | When unset |
|---|---|---|
| `AUTH0_MGMT_DOMAIN`, `AUTH0_MGMT_CLIENT_ID`, `AUTH0_MGMT_CLIENT_SECRET` | the tenant's canonical `*.auth0.com` domain (the Management API does not answer on a custom domain) and a machine-to-machine application with `delete:users` on the Management API. The same application must also be authorized for the API audience: its tokens sign the encoding-server purge calls | (any of the three) the Auth0 user and the vectors are kept; warnings `auth0_not_configured`, `vector_purge_skipped` |
| `ENCODING_PURGE_AUDIENCE` | audience of the token for `POST /purge-vectors` | `AUTH0_API_AUDIENCE` |
| `CUSTOMER_DOCUMENTS_BUCKET` | the encoding-server's documents bucket | `genflowly-{APP_ENV}-customer-documents` |

The deploy workflows copy the three `AUTH0_MGMT_*` GitHub environment secrets, when all are set, into the proxy's Fly secrets. The encoding-server accepts `POST /purge-vectors` only from a client-credentials token whose `azp` is listed in its `PURGE_ALLOWED_CLIENT_IDS` (set it to the M2M client id). Unset, every purge call gets a 403, and the jobs retry until they are stuck.

### PDF uploads switch (plan 4.4)

`PDF_UPLOADS_ENABLED` gates PDF attachments: off, `POST /attachments` for a PDF and a generate request carrying one get a 400 (images are unaffected). Unset, it is on everywhere but production; `fly.toml` sets it on for development and `fly.production.toml` off. Turn it on in production only when this section is live there: customer deletion (with the Message `customerIdIndex`), the claim, the backfill finished and the pending rule enabled. Turn on `REACT_APP_PDF_ATTACHMENTS` in the web app at the same time.

### Letterhead logos of System agents (plan 6.2)

A TOOL_EXECUTOR node's `tool_settings.generate_pdf` sets the PDF letterhead (`default_page_size`, `company_name`, `footer_text`, `accent_color`, `logo_attachment_id`); `GraphValidationService` rule 12 checks the values, and saving an agent refuses a logo id that is not a file under the graph owner's attachments or System's. Admins upload System agents' logos with `POST /api/v1/admin/letterhead-logo` (PNG or JPEG, at most 2 MB, presigned under `customers/System/attachments/`, untagged because the node row keeps it; System is never purged) and preview one with `GET /api/v1/admin/letterhead-logo/url?attachmentId=`. The retrieval-server reads a logo from the graph owner's prefix, then System's (retrieval-server/development.md, "Locale, page size and letterhead").

### Phantom Conversation rows

Before pending-run writes required the conversation's row, removing a share recipient's durable run created a key-only Conversation row under the recipient. The proxy now ignores rows without a `client` (`getConversationById`, the pending-run condition). `scripts/find_phantom_conversation_rows.py --region us-east-1` lists them per stage (read-only); `--delete` removes them, each under the condition that it still has no `client`.

### What deletion does not reach: backup windows

- **DynamoDB**: point-in-time recovery is on for every table, so deleted rows stay restorable for 35 days.
- **Supabase** (the Postgres run data): the project's own backups keep deleted rows for their retention window.
- **S3**: the attachments bucket is unversioned (verify it, above). The customer-documents bucket is versioned, and the purge deletes every version.
- Logs and metrics carry ids, never content (see the logging policy below), and are not purged.

## Observability — metrics & logging conventions

All services follow ONE set of metric-naming and dimension conventions, pinned here and implemented for Python in `encoding-library/src/encoding_library/observability/`. Dashboards and alarms live in Grafana (fed by Fly Prometheus for the Fly apps and CloudWatch for the lambdas), so a metric must mean the same thing no matter which service emitted it.

Dashboard JSONs live in `observability/grafana/`. All charts share a global status color scheme (green = success/2xx, yellow = warnings, red = errors/4xx/5xx) defined once in `observability/grafana/color-scheme.json` and stamped into every panel by `apply_color_scheme.py` — see the README there; never hand-edit colors in the dashboard JSONs.

### Logging policy — production logs problems only, never user content

Two independent layers keep production logs clean. Both key off `APP_ENV`: set in each Fly service's toml (`production` in `fly.production.toml`, `development` in `fly.toml`) and stamped on every encoding lambda by the CDK stacks from the deploy `STAGE`; unset — e.g. a local machine — means development.

1. **Level.** Production emits WARN/WARNING and above only; development logs the full INFO narrative (per-node traces, prompts, responses). Wiring:
   - **Kotlin proxy**: logback levels are `${LOG_LEVEL:-INFO}`; `fly.production.toml` sets `LOG_LEVEL=WARN`.
   - **retrieval-server**: `app.py` derives the level from `APP_ENV` (production → WARNING); an explicit `LOG_LEVEL` env var overrides it — e.g. a temporary INFO window while debugging production, which is safe because of layer 2.
   - **encoding-server lambdas**: every handler passes `default_log_level()` from `encoding-server/services/content_logging.py` to `setup_logging` (same WARNING/INFO/`LOG_LEVEL` semantics).
2. **Content gate (defense in depth).** Lines carrying user content — prompts, system prompts/instructions, LLM responses, memories, queries, request payloads, raw lambda events — are *additionally* gated per environment, so content cannot leak even when production runs at INFO: Python `content_logging.py` in each service (`if LOG_USER_CONTENT:` for whole-line dumps, `redact(value, limit)` for a single field), Kotlin `logContent = !appConfig.isProduction` threaded to where it's needed (see `Routing.kt`, `di/Modules.kt`).

Rules for every log line you add:

- **Never log PII or message content at any level** — emails, names, user/AI message text, tool payloads, API keys. ERROR lines included: if an error needs a content snippet to be debuggable, wrap it in `redact()` (Python) or gate it on `logContent` (Kotlin).
- **IDs are the correlators** — `customerId`, `conversationId`, `messageId`, `request_id` are fine at any level; ids + counts + error text is how production issues are traced (search `request_id:<id>`, see Request-id propagation below).
- **Auth subs are masked in production** — a sub is a pseudonymous *user* identifier, one step closer to a person than a customerId. In any WARN/ERROR line (they survive the production level cut), pass it through `LogSanitize.sub(...)` (Kotlin) or `mask_sub(...)` (lambdas) — production then shows `auth0|ab…`.
- **Write WARN/ERROR lines to stand alone** without the surrounding INFO story — in production they are all you get.
- INFO lines are dev-only by construction, but still gate any that embed user content: they must stay safe under a temporary `LOG_LEVEL=INFO` in production.

### API metrics & dashboards (proxy server)

Every proxy API automatically emits success/failure and latency metrics — the `MicrometerMetrics` plugin records each request on the `ktor_http_server_requests_seconds` timer with `route`, `method` and `status` labels (counts + duration histogram buckets). Nothing needs to be emitted by hand for a new route.

**Route naming convention: resource ids go in query parameters, never in the path.** A path-embedded id gives every request its own metric identity and fragments the per-API dashboards (`/api/v1/chat/84b6da46-...` instead of one `/api/v1/chat` series).

#### Creating a new API endpoint

1. **Flat, static path** under `/api/v1/`, named `resource` or `resource/action` (e.g. `/api/v1/conversation/pin`). Every segment is a fixed word — the full path is the API's identity in metrics, logs and dashboards.
2. **Identifiers go in query parameters** (`?conversationId=xx&messageId=xx`) for GET/POST-action routes, or in the JSON body for create/update payloads. Read them with `call.request.queryParameters["conversationId"]`, respond 400 when a required one is missing.
3. **Document query params** in the OpenAPI block with `queryParameter<String>(...) { required = true }` (see the checklist above for the full block).
4. Add the path constant to the `Routes` object in `Routing.kt` — don't build paths inline or append segments to a constant at the call site.
5. Frontend: URL-encode every query value (`encodeURIComponent`) in `endpoints.ts`.

**Antipattern — do NOT create routes like these.** Each of the following used to exist and fragmented the dashboards into one chart per UUID before being renamed to the query-param form next to it:

| ❌ Antipattern (path-embedded ids) | ✅ Replaced by |
|---|---|
| `/api/v1/chat/{conversationId}` | `/api/v1/chat?conversationId=` |
| `/api/v1/conversation/{conversationId}/pin` (+ `/unpin`) | `/api/v1/conversation/pin?conversationId=` |
| `/api/v1/conversation/{conversationId}/messages/{messageId}/learned-facts` | `/api/v1/conversation/learned-facts?conversationId=&messageId=` |
| `/api/v1/conversation/{conversationId}/shared` | `/api/v1/conversation/shared?conversationId=` |
| `/api/v1/conversation/{conversationId}/unarchive` | `/api/v1/conversation/unarchive?conversationId=` |
| `/api/v1/generations/{responseMessageId}/cancel` | `/api/v1/generations/cancel?responseMessageId=` |
| `/api/v1/instruction/{instructionId}/shared` | `/api/v1/instruction/shared?instructionId=` |
| `/api/v1/instruction/{instructionId}/{version}` | `/api/v1/instruction/version?instructionId=&version=` |
| `/api/v1/attachments/{attachmentId}/url` | `/api/v1/attachments/url?attachmentId=` |
| `/api/v1/admin/system-api-keys/{aiVendor}/models` | `/api/v1/admin/system-api-keys/models?aiVendor=` |

(A few `{param}` routes still remain, e.g. plain DELETE-by-id routes; they predate this convention — don't add new ones.)

**Dashboards**: the dedicated "Proxy Server APIs" (`observability/grafana/proxy-apis-*.json`) and "Retrieval Server APIs" (`retrieval-apis-*.json`) dashboards hold a chart pair per API — requests by status (colored by the global scheme) and p50/p90/p95/p99 latency — grouped into rows by subresource (`/api/v1/agents/...`, `/api/v1/conversation/...`, ...). They are generated, not hand-maintained: after adding or renaming a route in either server, run

```
python3 observability/grafana/generate_api_dashboards.py
```

and commit the regenerated dashboard JSONs. The script discovers proxy routes from `Routing.kt`/`activity/` and retrieval routes from `routes/*.py` decorators, and re-applies the color scheme, so the new API's charts show up automatically. CI deploys the JSONs to Grafana on push (`*-development.json` from `development`, `*-production.json` from `main`).

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
| `llm_request_total` / `llm_request_duration_seconds` | vendor, model, status; the counter also carries source (`conversation`\|`internal`\|a RequestType lowercased — the purpose forwarded from the proxy as `request_source`) and operation (graph node type) | retrieval-server LLM nodes — one increment per LLM API call, including agent-graph iterations, reflection passes and tool round trips |
| `llm_tokens_total` | vendor, model, direction (`input`\|`output`\|`cache_read`\|`cache_creation`) | retrieval-server LLM nodes |
| `llm_cost_usd_total` | vendor, model | Kotlin proxy (`CostCalculationService`) |
| `llm_cost_unpriced_total` | vendor, model | Kotlin proxy — turns with no catalog pricing (cost silently null) |
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
| `retry_attempt_total`, `retry_exhausted_total` | operation | encoding-library retry util (all services) |
| `ingest_notes/ingest_email/trigger_ingestion/parse_and_chunk/create_collections/voyage_batch_accumulate/voyage_batch_poll` (`_total`/`_duration_seconds`) | status | remaining encoding lambdas (`@track` on each handler) |
| `http_response_total` | operation (handler), status (actual HTTP statusCode, e.g. `202`\|`400`) | API-facing encoding lambdas — real HTTP outcome; `@track` alone reports ok for handled 4xx |
| `ingest_item_total` | data_type, status (`ok`\|`validation_error`\|`error`) | ingest handler, per item — catches partial failures inside 202 responses |
| `memory_load_failure_total` | — | retrieval-server memory node (swallowed by design, counted) |
| `memory_extraction_total` / `_duration_seconds` | source (`conversation`\|`note`), status | Kotlin proxy (`MemoryExtractionService`) |
| `memory_extraction_skipped_total` | source, status (`disabled`\|`empty`\|`debounced`\|`too_short`) | Kotlin proxy — extraction not attempted, by reason |
| `memory_extraction_unparseable_total` | source | Kotlin proxy — agent output blank or not valid JSON |
| `memory_operation_total` | operation (`add`\|`update`\|`delete`\|`unknown`), status (`ok`\|`noop`\|`error`) | Kotlin proxy — one per proposed memory operation |
| `memory_vector_failure_total` | operation (`encode`\|`delete`) | Kotlin proxy — memory vector push/delete failed (swallowed, counted) |
| `memory_learned_facts_write_failure_total` | — | Kotlin proxy — learned-facts marker write onto the message failed |
| `graph_stale_serve_total` | — | retrieval-server graph_loader (DDB failure papered over by cache) |
| `voice_session_total` / `voice_session_duration_seconds` | vendor, status (`ok`\|`error`\|`connect_failed`) | retrieval-server voice sessions |
| `internal_client_total` / `_duration_seconds` | operation (path), status (`ok`\|`4xx`\|`5xx`\|`error`=transport failure, plus `not_configured` on skipped encoding calls) | Kotlin proxy shared HttpClient → retrieval/encoding servers |
| `retention_claim_total` | status (`ok`\|`pending` = left to the reconciler) | Kotlin proxy — one per message write that links objects (see Retention) |
| `retention_claim_copies_total`, `retention_claim_missing_total`, `retention_release_failure_total` | — | Kotlin proxy claim — objects copied for another conversation, linked keys with no object, failed returns to `pending` |
| `retention_malformed_key_total` | operation (`claim`\|`purge`) | Kotlin proxy — linked keys outside `customers/{cid}/attachments/` and `customers/{cid}/agent-fs/`, skipped |
| `retention_claim_reconcile_total` | status (`ok`\|`pending`\|`error`) | Kotlin proxy `ClaimReconciler` |
| `retention_claim_overdue_total` | — | Kotlin proxy `ClaimReconciler` — a message pending more than 3 days; alert on any |
| `purge_jobs_total` | operation (`account`\|`conversation`), status (`requested`\|`done`\|`rescheduled`\|`error`\|`stuck`) | Kotlin proxy customer deletion — alert on `stuck` |
| `purge_objects_deleted_total` | operation (`conversation`\|`sweep`\|`documents`) | Kotlin proxy customer deletion — S3 objects (versions, for documents) deleted |
| `purge_errors_total` | operation (the failed step: `s3`\|`dynamodb`\|`sweep`, else `account`\|`conversation`) | Kotlin proxy `PurgeJobWorker` |
| `vector_purge_total` | operation (`delete_conversation`\|`drop_collections`\|`invalid`), status (`ok`\|`error`) | encoding-server `POST /purge-vectors` |

### Python services (retrieval-server, encoding lambdas)

Service-specific usage guides live next to each service — how to emit metrics, the swallowed-failure pattern, per-handler checklists and the retry rules:

- `retrieval-server/development.md`
- `encoding-server/development.md`

### Request-id propagation (end-to-end)

One request id follows a user request through every backend; search `request_id:<id>` in any service's logs to see the whole story:

1. **Kotlin proxy**: the `CallId` plugin adopts the caller's `X-Request-Id` or generates one, puts it in the MDC (so it's on every JSON log line) and echoes it in the response.
2. **Proxy → retrieval-server / encoding-server**: the shared `HttpClient` (Modules.kt) forwards the MDC id as `X-Request-Id` on every outbound call automatically — services never set the header by hand.
3. **Retrieval-server**: an app middleware adopts the incoming `X-Request-Id` (or mints one), binds it to the logging contextvar and echoes it back.
4. **Encoding lambdas**: the ingest lambdas read the header, call `set_request_id(...)` and stamp it into `MemoryRequestInternalState.request_id`, which rides the SQS message and Step Functions payloads — every downstream lambda (`trigger`, `parse_and_chunk`, `create_embeddings`, `store_embeddings`) calls `set_request_id(state.request_id)` on entry.

When adding a new lambda to the pipeline, preserve `request_id` on any state object you construct and call `set_request_id` first thing in the handler.

### Third-party calls: retry with exponential backoff

Every outbound call to a third-party API from Python code MUST go through `encoding_library.utils.retry` (`@retry` decorator, `retry_call`, or a `RetryingProxy`-wrapped client). Defaults: 3 attempts, 0.5s base delay, 2× backoff, 8s cap, equal jitter. Each retry emits `retry_attempt_total{operation}`; giving up emits `retry_exhausted_total{operation}`.

- **Milvus/Zilliz**: `get_milvus_client()` already returns a retry-wrapped client — use it, never construct `MilvusClient` directly.
- **Embeddings**: `create_embeddings()` retries internally (covers realtime and batch paths).
- **HTTP calls**: pass `retry_if=is_transient_http_error` so only connection errors, 429 and 5xx retry — a 401/404 must fail fast. Call `raise_for_status()` *inside* the retried function, or 429/5xx responses won't trigger a retry.
- **LLM chat calls are the exception**: they retry inside the vendor SDKs (`max_retries` in `graph/llm_factory.py`), not through this util — re-issuing a generation from our layer can double-bill when the original request actually succeeded. Same for key validation (SDK-level; auth errors must not retry).
- **boto3 (DynamoDB/S3/KMS)** has its own built-in backoff — don't double-wrap.
- **Voice realtime websockets** are stateful sessions; reconnection is session logic, deliberately not covered by this util.

### Kotlin proxy

The Kotlin twin of the Python util is `com.genflowly.observability.Metrics` (Micrometer + Prometheus registry, initialized in `Application.kt`, scraped by Fly via the `[metrics]` block in fly.toml; the `/metrics` route 404s for public fly-proxy traffic). It enforces the same conventions — allowed dimensions only, `_total` counters, `_duration_seconds` summaries recording seconds:

```kotlin
Metrics.count("llm_cost_usd_total", costUsd, "vendor" to vendor.metricVendor(), "model" to model)
Metrics.observe("some_op_duration_seconds", elapsedSeconds, "status" to "ok")
val result = Metrics.tracked("some_op") { doWork() }   // = Python @track
```

- **Vendor labels**: always use `AIVendor.metricVendor()` (`CLAUDE` → `"anthropic"`) so one Grafana query spans the proxy and the retrieval-server.
- **Cost** is emitted inside `CostCalculationService.computeCostUsd` — one point covers non-streaming, streaming and voice; do not add per-call-site emissions. `llm_cost_unpriced_total` counts turns that produced no cost for lack of catalog pricing.
- **HTTP metrics** come free from the `MicrometerMetrics` Ktor plugin (`ktor_http_server_requests_*`); per-request access logs come from `CallLogging`, JSON-formatted by logback's LogstashEncoder with a `request_id` MDC field from the `CallId` plugin (honors/returns `X-Request-Id`).
