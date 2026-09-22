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
import com.genflowly.repository.RequestAgentMapRepository
import com.genflowly.repository.SystemApiKeyRepository
import com.genflowly.service.AgentResolutionService
import com.genflowly.service.ConversationManagementService
import com.genflowly.service.GenerationAgentExecutor
import com.genflowly.service.RequestAgentDefaultsLoader
import com.genflowly.service.RequestAgentMapAdminService
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
import com.genflowly.observability.Metrics
import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import org.slf4j.MDC
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.kms.KmsClient
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.presigner.S3Presigner
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.RunsClient
import com.genflowly.providers.S3Provider
import com.genflowly.service.GraphService

fun appModule(): Module = module {
    single { provideJson() }
    single<KLogger> { logger("Logger") }
    single { AppConfig.fromEnv() }
    single { AppScope() }

    single {
        val client = HttpClient(CIO) {
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

        // One interceptor covers every outbound call from the shared client:
        // - propagates this request's id (CallId -> MDC) as X-Request-Id, so
        //   retrieval-server and encoding-lambda logs correlate end-to-end;
        // - emits internal_client_total/_duration_seconds for calls to our
        //   internal services (paths are a bounded set, so `operation` is a
        //   safe dimension). WebSocket upgrades get the header but no
        //   duration metric — a session's lifetime is not a request latency.
        val internalHosts = listOfNotNull(
            get<AppConfig>().retrievalServerUrl,
            get<AppConfig>().encodingServerUrl,
        ).mapNotNull { runCatching { Url(it).host }.getOrNull() }.toSet()

        client.plugin(HttpSend).intercept { request ->
            MDC.get("request_id")?.let { rid ->
                if (request.headers[HttpHeaders.XRequestId] == null) {
                    request.headers.append(HttpHeaders.XRequestId, rid)
                }
            }
            val isInternalHttp = request.url.host in internalHosts &&
                !request.url.protocol.isWebsocket()
            if (!isInternalHttp) {
                execute(request)
            } else {
                val operation = request.url.encodedPath
                val start = System.nanoTime()
                try {
                    val call = execute(request)
                    // 4xx vs 5xx matters here: a wall of 4xx means our token/config
                    // is rejected (as in the encoding-gateway 401 outage), 5xx means
                    // the downstream service is broken.
                    val status = when {
                        call.response.status.value < 400 -> "ok"
                        call.response.status.value < 500 -> "4xx"
                        else -> "5xx"
                    }
                    Metrics.count("internal_client_total", 1.0, "operation" to operation, "status" to status)
                    Metrics.observe(
                        "internal_client_duration_seconds",
                        (System.nanoTime() - start) / 1e9,
                        "operation" to operation,
                    )
                    call
                } catch (t: Throwable) {
                    Metrics.count("internal_client_total", 1.0, "operation" to operation, "status" to "error")
                    throw t
                }
            }
        }
        client
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
    single { RunsClient(get(), get(), get(), get<AppConfig>().retrievalServerUrl) }
    single { EncodingServerClient(get(), get(), get<AppConfig>().encodingServerUrl) }

    // Per-domain repositories (the dissolved DynamoDBProvider)
    single { ConversationRepository(get(), get()) }
    single { CustomerProfileRepository(get(), get()) }
    single { ShareRepository(get(), get()) }
    single { CustomerCredentialsRepository(get(), get()) }
    single { com.genflowly.repository.CustomerToolsRepository(get(), get()) }
    single { com.genflowly.repository.EmbeddingModelCatalogRepository(get(), get()) }
    single { DeveloperApiKeyRepository(get(), get()) }
    single { SystemApiKeyRepository(get(), get()) }
    single { ModelCatalogRepository(get(), get()) }
    single { NotesRepository(get(), get()) }
    single { com.genflowly.repository.MemoryRepository(get(), get()) }
    single { InstructionRepository(get(), get()) }
    single { GraphRepository(get(), get()) }
    single { RequestAgentMapRepository(get(), get()) }

    single { SharedUsersResolver(get(), get()) }
    single {
        com.genflowly.service.EmbeddingModelCatalogService(
            get(), get(), get(), get(), get<com.genflowly.di.AppScope>()
        )
    }
    single { CustomerCredentialsService(get(), get(), get(), get(), get(), get(), get(), get()) }
    single {
        com.genflowly.service.CustomerToolsService(
            get(), get(), get(), get<AppConfig>().retrievalServerUrl
        )
    }
    single { com.genflowly.service.VendorAllowlistService(get()) }
    single { UtilityGenerationService(get(), get()) }
    single { GraphService(get(), get(), get()) }
    single { com.genflowly.repository.NodePresetRepository(get(), get()) }
    single { com.genflowly.service.NodePresetService(get(), get()) }
    single { RequestAgentDefaultsLoader() }
    single { AgentResolutionService(get(), get(), get(), get()) }
    single { GenerationAgentExecutor(get(), get(), get(), get(), get(), get()) }
    single { RequestAgentMapAdminService(get(), get(), get()) }
    single { com.genflowly.service.CustomerRequestAgentMapService(get(), get(), get()) }
    single { CustomerProfileService(get(), get(), get(), get()) }
    single { InstructionService(get(), get(), get(), get(), get(), get(), get(), get(), get()) }
    single { ConversationService(get(), get(), get()) }
    single { ConversationManagementService(get(), get(), get(), get(), get(), get()) }
    single { GenerationRequestValidator(get()) }
    single { com.genflowly.service.MemoryService(get(), get(), get(), get()) }
    single {
        com.genflowly.service.MemoryExtractionService(
            get(), get(), get(), get(), get(), get(), get(), get(), get(),
            logContent = !get<AppConfig>().isProduction
        )
    }
    single { com.genflowly.service.ConversationIndexingService(get(), get(), get(), get()) }
    single { com.genflowly.service.ExchangeSideEffects(get(), get()) }
    single { com.genflowly.service.UnifiedSearchService(get(), get(), get(), get()) }
    single { GenerationOrchestrator(get(), get(), get(), get(), get(), get(), get(), get(), get(), get(), get(), get()) }
    single { com.genflowly.service.AttachmentService(get()) }
    single { com.genflowly.service.VoiceSessionService(get(), get(), get(), get(), get(), get(), get()) }
    single { AIModelsService(get(), get()) }
    single { com.genflowly.service.NotesService(get(), get(), get(), get(), get(), get(), get(), get()) }
    single { com.genflowly.service.DeveloperApiKeyService(get(), get(), get()) }
    single { com.genflowly.service.SystemApiKeyService(get(), get(), get()) }
    single { com.genflowly.service.ModelCatalogService(get(), get(), get()) }
    single { com.genflowly.service.CostCalculationService(get()) }
}

fun provideJson(): Json {
    return Json {
        ignoreUnknownKeys = true
        isLenient = true
    }
}
