package com.genflowly


import com.genflowly.aicallerlib.di.commonModule
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.*
import org.koin.core.context.startKoin

fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

fun Application.module() {
    install(ContentNegotiation) {
        json()
    }

    val claudeApiKey = "***REDACTED***" +
            "***REDACTED***"

    val geminiApiKey = "***REDACTED***"

    val openAIApiKey = "***REDACTED***"

    startKoin {
        properties(
            mapOf(
                "claude.api.key" to claudeApiKey,
                "gemini.api.key" to geminiApiKey,
                "openai.api.key" to openAIApiKey
            )
        )
        modules(commonModule()) // Using your commonModule here
    }


    configureRouting()
}
