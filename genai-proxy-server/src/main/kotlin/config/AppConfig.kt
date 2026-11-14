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
    val auth0Audience: String?,
    /** Auth0 application clientIds whose tokens belong to the web app (matched against azp). */
    val reactAppAuth0ClientIds: Set<String>,
    /** Auth0 application clientIds whose tokens belong to the admin panel (matched against azp). */
    val adminPanelAuth0ClientIds: Set<String>,
    /** Email domain required for admin-panel accounts (no leading @). */
    val adminEmailDomain: String,
    /** Deployment environment from APP_ENV: "production" on the prod Fly app, "development" otherwise. */
    val environment: String,
    /**
     * Route agentic streaming chat through the retrieval-server's durable /runs
     * path (DBOS workflow + Postgres checkpoint + reattachable stream) instead of
     * the stateless /retrieve stream. Off by default; dark-shipped behind
     * DURABLE_RUNS_ENABLED until the durable path is proven end-to-end.
     */
    val durableRunsEnabled: Boolean,
    /** Versioned bucket of batch-mode note documents (CUSTOMER_DOCUMENTS_BUCKET); null skips its purge. */
    val customerDocumentsBucket: String? = null,
    /** Auth0 Management API credentials for deleting a user's login; null unless all of AUTH0_MGMT_* are set. */
    val auth0Management: Auth0ManagementConfig? = null,
    /** SNS topic that emails the support inbox; null skips the email for a content report. */
    val supportTopicArn: String? = null
) {
    val isProduction: Boolean get() = environment == "production"

    /**
     * Maps a JWT azp claim (the Auth0 application the token was issued to) to
     * the profile client identifier, or null when the azp is not configured —
     * callers then fall back to sub-only resolution.
     */
    fun clientAppForAzp(azp: String?): String? {
        val normalized = azp?.trim()?.lowercase() ?: return null
        return when (normalized) {
            in reactAppAuth0ClientIds -> CLIENT_REACT_APP
            in adminPanelAuth0ClientIds -> CLIENT_ADMIN_PANEL
            else -> null
        }
    }

    companion object {
        const val CLIENT_REACT_APP = "REACT_APP"
        const val CLIENT_ADMIN_PANEL = "ADMIN_PANEL"

        fun fromEnv(): AppConfig = AppConfig(
            awsRegion = System.getenv("AWS_REGION") ?: "us-east-1",
            retrievalServerUrl = System.getenv("RETRIEVAL_SERVER_URL") ?: "http://retrieval-server:5001",
            encodingServerUrl = System.getenv("ENCODING_SERVER_URL")?.takeIf { it.isNotBlank() },
            kmsKeyId = System.getenv("KMS_KEY_ID") ?: error("KMS_KEY_ID is not set"),
            attachmentsBucket = System.getenv("ATTACHMENTS_BUCKET") ?: "",
            adminEmails = envList("ADMIN_EMAILS"),
            adminCustomerIds = envList("ADMIN_CUSTOMER_IDS"),
            auth0Domain = System.getenv("AUTH0_SPA_DOMAIN"),
            auth0Audience = System.getenv("AUTH0_API_AUDIENCE"),
            reactAppAuth0ClientIds = envList("AUTH0_REACT_APP_CLIENT_IDS"),
            adminPanelAuth0ClientIds = envList("AUTH0_ADMIN_PANEL_CLIENT_IDS"),
            adminEmailDomain = System.getenv("ADMIN_EMAIL_DOMAIN")?.trim()?.removePrefix("@")?.lowercase()
                ?.takeIf { it.isNotEmpty() } ?: "genflowly.com",
            environment = System.getenv("APP_ENV")?.trim()?.lowercase()
                ?.takeIf { it.isNotEmpty() } ?: "development",
            durableRunsEnabled = System.getenv("DURABLE_RUNS_ENABLED")?.trim()?.lowercase() == "true",
            customerDocumentsBucket = System.getenv("CUSTOMER_DOCUMENTS_BUCKET")?.trim()?.takeIf { it.isNotEmpty() },
            auth0Management = auth0ManagementFromEnv(),
            supportTopicArn = System.getenv("SUPPORT_TOPIC_ARN")?.trim()?.takeIf { it.isNotEmpty() }
        )

        private fun auth0ManagementFromEnv(): Auth0ManagementConfig? {
            val domain = System.getenv("AUTH0_MGMT_DOMAIN")?.trim()?.removePrefix("https://")?.trimEnd('/')
            val clientId = System.getenv("AUTH0_MGMT_CLIENT_ID")?.trim()
            val clientSecret = System.getenv("AUTH0_MGMT_CLIENT_SECRET")?.trim()
            if (domain.isNullOrEmpty() || clientId.isNullOrEmpty() || clientSecret.isNullOrEmpty()) return null
            return Auth0ManagementConfig(domain, clientId, clientSecret)
        }

        private fun envList(name: String): Set<String> =
            System.getenv(name)
                ?.split(",")
                ?.map { it.trim().lowercase() }
                ?.filter { it.isNotEmpty() }
                ?.toSet()
                ?: emptySet()
    }
}

/**
 * A machine-to-machine Auth0 application authorized for the Management API
 * with the delete:users scope. [domain] is the tenant's canonical domain
 * (e.g. genflowly.us.auth0.com), which the Management API audience requires.
 */
data class Auth0ManagementConfig(val domain: String, val clientId: String, val clientSecret: String) {
    override fun toString(): String = "Auth0ManagementConfig(domain=$domain, clientId=$clientId, clientSecret=***)"
}
