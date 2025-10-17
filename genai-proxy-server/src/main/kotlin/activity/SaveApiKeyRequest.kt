package activity

import com.genflowly.Routes
import io.ktor.server.routing.post
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable
import models.SaveApiKeyResponse
import org.slf4j.LoggerFactory
import service.ApiKeyService

@Serializable
data class SaveApiKeyRequest(
    val email: String,
    val oidpProvider: String,
    val apiKey: String
)

private val logger = LoggerFactory.getLogger("SaveApiKeyRoute")

fun Route.registerSaveApiKeyRoutes(apiKeyService: ApiKeyService) {
    post(Routes.SAVE_API_KEY) {
        val request = call.receive<SaveApiKeyRequest>()
        logger.info("Received SaveApiKeyRequest: {}", request)

        apiKeyService.saveApiKey(
            email = request.email,
            provider = request.oidpProvider,
            apiKey = request.apiKey
        )

        val response = SaveApiKeyResponse(
            status = "API key saved for vendor ${request.oidpProvider}"
        )
        call.respond(response)
    }
}
