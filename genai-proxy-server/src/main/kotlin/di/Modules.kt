package com.genflowly.di

import com.genflowly.providers.DynamoDBProvider
import com.genflowly.providers.KMSProvider
import com.genflowly.service.AIRequestService
import kotlinx.serialization.json.Json
import mu.KLogger
import mu.KotlinLogging.logger
import org.koin.core.module.Module
import org.koin.dsl.module
import service.AIRequestManager
import service.CustomerProfileService
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.kms.KmsClient

fun appModule(): Module = module {
    single { provideJson() }
    single<KLogger> { logger("Logger") }

    single {
        DynamoDbClient.builder()
            .region(Region.of(System.getenv("AWS_REGION") ?: "us-east-1"))
            .build()
    }

    single {
        KmsClient.builder()
            .region(Region.of(System.getenv("AWS_REGION") ?: "us-east-1"))
            .build()
    }

    single { DynamoDBProvider(get(), get()) }
    single { KMSProvider(get(), get()) }
    single { AIRequestService(get()) }
    single { CustomerProfileService(get(), get()) }
    single { AIRequestManager(get(), get()) }

}

fun provideJson(): Json {
    return Json {
        ignoreUnknownKeys = true
        isLenient = true
    }
}


