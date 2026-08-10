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
