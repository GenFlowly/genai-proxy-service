package activity

import com.genflowly.Routes
import io.ktor.server.routing.post
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable
import models.SaveApiKeyResponse

@Serializable
data class SaveApiKeyRequest(val vendor: String, val apiKey: String)

val apiKeys = mutableMapOf<String, String>()

fun Route.registerSaveApiKeyRoutes() {
    post(Routes.SAVE_API_KEY) {
        val request = call.receive<SaveApiKeyRequest>()
        apiKeys[request.vendor] = request.apiKey
        val response = SaveApiKeyResponse(
            status = "API key saved for vendor ${request.vendor}"
        )
        call.respond(response)
    }
}
