package com.genflowly


import com.genflowly.aicallerlib.di.commonModule
import com.genflowly.di.appModule
import com.genflowly.service.AIRequestService
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.*
import org.koin.core.context.startKoin
import org.koin.ktor.ext.get
import service.ApiKeyService

fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

fun Application.module() {
    install(ContentNegotiation) {
        json()
    }

    startKoin {
        modules(
            appModule(),
            commonModule()
        )
    }


    val aiService = get<AIRequestService>()
    val apiKeyService = get<ApiKeyService>()

    configureRouting(aiService, apiKeyService)
}
