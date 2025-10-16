package com.genflowly.di

import com.genflowly.providers.DynamoDBProvider
import com.genflowly.service.AIRequestService
import kotlinx.serialization.json.Json
import mu.KLogger
import mu.KotlinLogging.logger
import org.koin.core.module.Module
import org.koin.dsl.module

fun appModule(): Module = module {
    single { provideJson() }
    single<KLogger> { logger("Logger") }

    single { DynamoDBProvider() }
    single { AIRequestService(get()) }

}

fun provideJson(): Json {
    return Json {
        ignoreUnknownKeys = true
        isLenient = true
    }
}


