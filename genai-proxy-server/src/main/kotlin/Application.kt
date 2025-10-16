package com.genflowly


import com.genflowly.aicallerlib.di.commonModule
import com.genflowly.di.appModule
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

    startKoin {
        modules(
            appModule(),
            commonModule()
        )
    }


    configureRouting()
}
