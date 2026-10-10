package com.genflowly.activity.customer

import com.genflowly.Routes
import com.genflowly.config.AppConfig
import com.genflowly.models.api.OnboardCustomerResponse
import com.genflowly.service.CustomerProfileService
import com.genflowly.utils.LogSanitize
import com.genflowly.utils.authenticatedAzp
import com.genflowly.utils.authenticatedSub
import io.github.smiley4.ktoropenapi.post
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.http.HttpHeaders
import com.genflowly.models.OnboardCustomerRequest
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("OnboardCustomerRoute")

fun Route.registerOnboardCustomerRoutes(
    customerProfileService: CustomerProfileService,
    appConfig: AppConfig
) {
    authenticate("auth0") {
        post(Routes.ONBOARD_CUSTOMER, {
            tags("Customer")
            summary = "Onboard the authenticated user"
            description = "Creates (or returns) the customer profile for the authenticated Auth0 " +
                    "identity. Must be called once before any other endpoint; other endpoints " +
                    "return 403 for identities without a profile. Returns the full bootstrap state: " +
                    "preferences, API-key statuses, instructions and configuration statuses. " +
                    "Web-app only: requires an Auth0 JWT; not accessible with a developer API key."
            request {
                body<OnboardCustomerRequest> {
                    description = "Auth0 identity attributes (sub, client, email, name, picture)"
                    required = true
                }
            }
            response {
                code(HttpStatusCode.OK) {
                    description = "Customer profile and bootstrap state"
                    body<OnboardCustomerResponse>()
                }
            }
        }) {
            val request = call.receive<OnboardCustomerRequest>()

            // The profile identity comes from the token, never the body — a
            // caller must not be able to onboard (or read) another sub's profile.
            val tokenSub = call.authenticatedSub()
            if (tokenSub == null || tokenSub != request.sub) {
                logger.warn(
                    "Onboarding sub mismatch: body sub={} token sub={}",
                    LogSanitize.sub(request.sub), LogSanitize.sub(tokenSub)
                )
                call.respond(HttpStatusCode.Forbidden, mapOf("error" to "sub does not match token"))
                return@post
            }

            // When the token's azp maps to a known app, it decides which app's
            // account this is — the body's client is only a legacy fallback.
            val azpClient = appConfig.clientAppForAzp(call.authenticatedAzp())
            if (azpClient != null && azpClient != request.client) {
                logger.warn("Onboarding client mismatch: body client={} azp client={}", request.client, azpClient)
            }
            val client = azpClient ?: request.client

            if (client == AppConfig.CLIENT_ADMIN_PANEL) {
                val emailDomain = request.email?.substringAfterLast('@', "")?.lowercase()
                if (emailDomain != appConfig.adminEmailDomain) {
                    // Email is PII — production logs only the (failing) domain.
                    val rejected = if (appConfig.isProduction) "domain=${emailDomain ?: "none"}"
                                   else (request.email ?: "not provided")
                    logger.warn("Rejected admin-panel onboarding for {}", rejected)
                    call.respond(
                        HttpStatusCode.Forbidden,
                        mapOf("error" to "Admin panel requires a @${appConfig.adminEmailDomain} account")
                    )
                    return@post
                }
            }

            logger.info(
                "Onboarding user: sub={}, client={}, email={}, name={}, picture={}",
                request.sub,
                client,
                request.email ?: "not provided",
                request.name ?: "not provided",
                request.picture ?: "not provided",
            )

            val authHeader = call.request.headers[HttpHeaders.Authorization]

            val response = customerProfileService.onboardAndBootstrap(
                sub = request.sub,
                client = client,
                email = request.email,
                name = request.name,
                picture = request.picture,
                authHeader = authHeader
            )

            call.respond(response)
        }
    }
}


