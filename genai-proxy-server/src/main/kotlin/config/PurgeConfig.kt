package com.genflowly.config

/**
 * Environment-derived configuration of customer deletion (plan 3.9), read
 * once at startup like [AppConfig]. Everything is optional: a missing piece
 * makes the matching purge step skip with a WARNING recorded on the job.
 */
data class PurgeConfig(
    /**
     * Auth0 tenant domain for the Management API (the canonical
     * *.auth0.com domain, not a custom domain). AUTH0_MGMT_DOMAIN.
     */
    val auth0ManagementDomain: String?,
    /** Machine-to-machine application with delete:users. AUTH0_MGMT_CLIENT_ID. */
    val auth0ManagementClientId: String?,
    /** AUTH0_MGMT_CLIENT_SECRET. */
    val auth0ManagementClientSecret: String?,
    /**
     * Audience of the client-credentials token the encoding-server's
     * POST /purge-vectors accepts (its API Gateway JWT authorizer audience).
     * ENCODING_PURGE_AUDIENCE, defaulting to AUTH0_API_AUDIENCE.
     */
    val encodingPurgeAudience: String?,
    /**
     * The encoding-server's versioned per-customer documents bucket.
     * CUSTOMER_DOCUMENTS_BUCKET, defaulting to genflowly-{APP_ENV}-customer-documents
     * (the name encoding-server-cdk gives it).
     */
    val customerDocumentsBucket: String
) {
    val auth0ManagementConfigured: Boolean
        get() = !auth0ManagementDomain.isNullOrBlank() &&
            !auth0ManagementClientId.isNullOrBlank() &&
            !auth0ManagementClientSecret.isNullOrBlank()

    companion object {
        fun fromEnv(appConfig: AppConfig): PurgeConfig = PurgeConfig(
            auth0ManagementDomain = env("AUTH0_MGMT_DOMAIN")?.removePrefix("https://")?.trimEnd('/'),
            auth0ManagementClientId = env("AUTH0_MGMT_CLIENT_ID"),
            auth0ManagementClientSecret = env("AUTH0_MGMT_CLIENT_SECRET"),
            encodingPurgeAudience = env("ENCODING_PURGE_AUDIENCE") ?: appConfig.auth0Audience,
            customerDocumentsBucket = env("CUSTOMER_DOCUMENTS_BUCKET")
                ?: "genflowly-${appConfig.environment}-customer-documents"
        )

        private fun env(name: String): String? = System.getenv(name)?.trim()?.takeIf { it.isNotEmpty() }
    }
}
