package com.genflowly


import com.genflowly.aicallerlib.di.commonModule
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.*
import org.koin.core.context.startKoin
import providers.ApiKeyProvider

fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

fun Application.module() {
    install(ContentNegotiation) {
        json()
    }

    val claudeApiKey = ApiKeyProvider.getApiKey("claude") ?: error("Missing Claude API key")
    val geminiApiKey = ApiKeyProvider.getApiKey("gemini") ?: error("Missing Gemini API key")
    val openAIApiKey = ApiKeyProvider.getApiKey("openai") ?: error("Missing OpenAI API key")

    startKoin {
        properties(
            mapOf(
                "claude.api.key" to claudeApiKey,
                "gemini.api.key" to geminiApiKey,
                "openai.api.key" to openAIApiKey
            )
        )
        modules(commonModule())
    }


    configureRouting()
}
