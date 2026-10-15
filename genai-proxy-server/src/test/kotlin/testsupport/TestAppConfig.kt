package com.genflowly.testsupport

import com.genflowly.config.AppConfig

/** An AppConfig for route tests; [adminCustomerIds] are admins without any profile lookup. */
fun testAppConfig(adminCustomerIds: Set<String> = emptySet()) = AppConfig(
    awsRegion = "us-east-1",
    retrievalServerUrl = "http://retrieval-server:5001",
    encodingServerUrl = null,
    kmsKeyId = "test-key",
    attachmentsBucket = "test-bucket",
    adminEmails = emptySet(),
    adminCustomerIds = adminCustomerIds,
    auth0Domain = null,
    auth0Audience = null,
    reactAppAuth0ClientIds = emptySet(),
    adminPanelAuth0ClientIds = emptySet(),
    adminEmailDomain = "genflowly.com",
    environment = "development",
    durableRunsEnabled = false
)
