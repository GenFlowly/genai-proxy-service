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

    val claudeApiKey = "sk-ant-api03-WVWUa692W-uK88UAP0xd1Oz-A1plP" +
            "-Sq0yXXbASG3CGywclHFSUch1Tn77iT3UrVX_vlbgkaklZAnfMsEv9Ycw-m1g5rgAA"

    val geminiApiKey = "AIzaSyCnwizVIg4MMvhxE5QxpJrjayxdmRS5xe8"

    val openAIApiKey = "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"

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
