package com.genflowly.di

import com.genflowly.config.AppConfig
import com.genflowly.providers.KMSProvider
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.DeveloperApiKeyRepository
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.ModelCatalogRepository
import com.genflowly.repository.NotesRepository
import com.genflowly.repository.ShareRepository
import com.genflowly.repository.SystemApiKeyRepository
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.ConversationService
import kotlinx.serialization.json.Json
import mu.KLogger
import mu.KotlinLogging.logger
import org.koin.core.module.Module
import org.koin.dsl.module
import com.genflowly.service.CustomerCredentialsService
import com.genflowly.service.GenerationOrchestrator
import com.genflowly.service.GenerationRequestValidator
import com.genflowly.service.InstructionService
import com.genflowly.service.SharedUsersResolver
import com.genflowly.service.UtilityGenerationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.AIModelsService
import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.serialization.kotlinx.json.*
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.kms.KmsClient
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.presigner.S3Presigner
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.S3Provider
import com.genflowly.service.GraphService

fun appModule(): Module = module {
    single { provideJson() }
    single<KLogger> { logger("Logger") }
    single { AppConfig.fromEnv() }
    single { AppScope() }

    single {
        HttpClient(CIO) {
            engine {
                // Disabled at the engine level so long-lived WebSocket voice
                // sessions aren't cut off; REST calls are still bounded by the
                // HttpTimeout plugin below (with per-request overrides).
                requestTimeout = 0
            }
            install(HttpRequestRetry) {
                retryOnServerErrors(maxRetries = 3)
                exponentialDelay()
            }
            install(HttpTimeout) {
                requestTimeoutMillis = 60_000L
                connectTimeoutMillis = 30_000L
                socketTimeoutMillis = 60_000L
            }
            install(ContentNegotiation) {
                json(get<Json>())
            }
            install(io.ktor.client.plugins.websocket.WebSockets)
        }
    }

    single {
        DynamoDbClient.builder()
            .region(Region.of(get<AppConfig>().awsRegion))
            .build()
    }

    single {
        KmsClient.builder()
            .region(Region.of(get<AppConfig>().awsRegion))
            .build()
    }

    single {
        S3Client.builder()
            .region(Region.of(get<AppConfig>().awsRegion))
            .build()
    }

    single {
        S3Presigner.builder()
            .region(Region.of(get<AppConfig>().awsRegion))
            .build()
    }

    single { KMSProvider(get(), get(), get<AppConfig>().kmsKeyId) }
    single { S3Provider(get(), get(), get(), get<AppConfig>().attachmentsBucket) }
    single { RetrievalServerClient(get(), get(), get(), get<AppConfig>().retrievalServerUrl) }
    single { EncodingServerClient(get(), get(), get<AppConfig>().encodingServerUrl) }

    // Per-domain repositories (the dissolved DynamoDBProvider)
    single { ConversationRepository(get(), get()) }
    single { CustomerProfileRepository(get(), get()) }
    single { ShareRepository(get(), get()) }
    single { CustomerCredentialsRepository(get(), get()) }
    single { DeveloperApiKeyRepository(get(), get()) }
    single { SystemApiKeyRepository(get(), get()) }
    single { ModelCatalogRepository(get(), get()) }
    single { NotesRepository(get(), get()) }
    single { InstructionRepository(get(), get()) }
    single { GraphRepository(get(), get()) }

    single { SharedUsersResolver(get(), get()) }
    single { CustomerCredentialsService(get(), get(), get(), get(), get()) }
    single { UtilityGenerationService(get(), get(), get()) }
    single { GraphService(get()) }
    single { CustomerProfileService(get(), get(), get(), get()) }
    single { InstructionService(get(), get(), get(), get(), get(), get(), get()) }
    single { ConversationService(get(), get()) }
    single { ConversationManagementService(get(), get(), get(), get(), get()) }
    single { GenerationRequestValidator(get()) }
    single { GenerationOrchestrator(get(), get(), get(), get(), get(), get()) }
    single { com.genflowly.service.AttachmentService(get()) }
    single { com.genflowly.service.VoiceSessionService(get(), get(), get(), get(), get()) }
    single { AIModelsService(get(), get()) }
    single { com.genflowly.service.NotesService(get(), get(), get(), get(), get(), get(), get()) }
    single { com.genflowly.service.DeveloperApiKeyService(get(), get(), get()) }
    single { com.genflowly.service.SystemApiKeyService(get(), get(), get()) }
    single { com.genflowly.service.SystemAIFailoverService(get()) }
    single { com.genflowly.service.ModelCatalogService(get(), get(), get()) }
}

fun provideJson(): Json {
    return Json {
        ignoreUnknownKeys = true
        isLenient = true
    }
}
