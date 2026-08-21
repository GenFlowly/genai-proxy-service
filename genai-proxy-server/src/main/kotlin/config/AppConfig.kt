package com.genflowly.config

/**
 * All environment-derived configuration, read once at startup and injected via
 * Koin. Classes must take the values they need through their constructors
 * instead of calling System.getenv themselves.
 */
data class AppConfig(
    val awsRegion: String,
    val retrievalServerUrl: String,
    /** Null when ENCODING_SERVER_URL is unset — callers skip encoding-server work. */
    val encodingServerUrl: String?,
    val kmsKeyId: String,
    /** Empty when ATTACHMENTS_BUCKET is unset — attachment presigning then fails at call time. */
    val attachmentsBucket: String,
    val adminEmails: Set<String>,
    val adminCustomerIds: Set<String>,
    /** Auth0 SPA tenant domain (JWKS issuer host). Null only when auth is unconfigured. */
    val auth0Domain: String?,
    /** Expected Auth0 API audience on incoming JWTs. Null only when auth is unconfigured. */
    val auth0Audience: String?
) {
    companion object {
        fun fromEnv(): AppConfig = AppConfig(
            awsRegion = System.getenv("AWS_REGION") ?: "us-east-1",
            retrievalServerUrl = System.getenv("RETRIEVAL_SERVER_URL") ?: "http://retrieval-server:5001",
            encodingServerUrl = System.getenv("ENCODING_SERVER_URL")?.takeIf { it.isNotBlank() },
            kmsKeyId = System.getenv("KMS_KEY_ID") ?: error("KMS_KEY_ID is not set"),
            attachmentsBucket = System.getenv("ATTACHMENTS_BUCKET") ?: "",
            adminEmails = envList("ADMIN_EMAILS"),
            adminCustomerIds = envList("ADMIN_CUSTOMER_IDS"),
            auth0Domain = System.getenv("AUTH0_SPA_DOMAIN"),
            auth0Audience = System.getenv("AUTH0_API_AUDIENCE")
        )

        private fun envList(name: String): Set<String> =
            System.getenv(name)
                ?.split(",")
                ?.map { it.trim().lowercase() }
                ?.filter { it.isNotEmpty() }
                ?.toSet()
                ?: emptySet()
    }
}
