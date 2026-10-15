package com.genflowly.config

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** PDF_UPLOADS_ENABLED (plan 4.4): explicit values win; unset means on except in production. */
class AppConfigPdfUploadsTest {

    @Test
    fun `unset or blank is on in development and off in production`() {
        assertTrue(AppConfig.pdfUploadsEnabled(null, isProduction = false))
        assertTrue(AppConfig.pdfUploadsEnabled("  ", isProduction = false))
        assertFalse(AppConfig.pdfUploadsEnabled(null, isProduction = true))
        assertFalse(AppConfig.pdfUploadsEnabled("", isProduction = true))
    }

    @Test
    fun `an explicit value wins in every environment`() {
        assertTrue(AppConfig.pdfUploadsEnabled("true", isProduction = true))
        assertTrue(AppConfig.pdfUploadsEnabled(" TRUE ", isProduction = true))
        assertFalse(AppConfig.pdfUploadsEnabled("false", isProduction = false))
        assertFalse(AppConfig.pdfUploadsEnabled("yes", isProduction = false))
    }
}
