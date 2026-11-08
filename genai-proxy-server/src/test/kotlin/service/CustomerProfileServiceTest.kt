package com.genflowly.service

import com.genflowly.config.AppConfig
import com.genflowly.repository.CustomerProfileRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Onboarding-completed flag: a missing attribute on an existing row means the
 * account predates this feature and must never see the first-time wizard
 * (defaults true); a brand-new row always starts false.
 */
class CustomerProfileServiceTest {

    private val sub = "auth0|abc"
    private val client = "REACT_APP"

    private val profileRepo = mockk<CustomerProfileRepository>()
    private val credentialsService = mockk<CustomerCredentialsService>(relaxed = true)
    private val instructionService = mockk<InstructionService>(relaxed = true)
    private val appConfig = mockk<AppConfig>(relaxed = true)
    private val cacheVersions = mockk<CacheVersionService>(relaxed = true)
    private val service = CustomerProfileService(profileRepo, credentialsService, instructionService, appConfig, cacheVersions)

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    @Test
    fun `existing row without the attribute defaults onboardingCompleted to true`() = runTest {
        coEvery { profileRepo.getCustomerProfile(sub, client) } returns mapOf(
            "customerId" to s("cust-1")
        )

        val profile = service.onboardCustomer(sub, client, null, "John", null)

        assertEquals(true, profile.onboardingCompleted)
    }

    @Test
    fun `existing row with onboardingCompleted explicitly false stays false`() = runTest {
        coEvery { profileRepo.getCustomerProfile(sub, client) } returns mapOf(
            "customerId" to s("cust-1"),
            "onboardingCompleted" to AttributeValue.builder().bool(false).build()
        )

        val profile = service.onboardCustomer(sub, client, null, "John", null)

        assertEquals(false, profile.onboardingCompleted)
    }

    @Test
    fun `brand new user starts with onboardingCompleted false`() = runTest {
        coEvery { profileRepo.getCustomerProfile(sub, client) } returns null
        coEvery { profileRepo.onboardCustomer(sub, client, any(), null, "Jane", null) } returns "jane-abc123"

        val profile = service.onboardCustomer(sub, client, null, "Jane", null)

        assertEquals(false, profile.onboardingCompleted)
    }

    @Test
    fun `completeOnboarding delegates to the repository`() = runTest {
        coEvery { profileRepo.markOnboardingCompleted(sub, client) } returns UpdateItemResponse.builder().build()

        service.completeOnboarding(sub, client)

        coVerify(exactly = 1) { profileRepo.markOnboardingCompleted(sub, client) }
    }

    private fun n(v: Int): AttributeValue = AttributeValue.builder().n(v.toString()).build()

    private fun existingProfile(vararg extra: Pair<String, AttributeValue>) {
        coEvery { profileRepo.getCustomerProfile(sub, client) } returns mapOf("customerId" to s("cust-1")) + extra
    }

    private fun stubBootstrapReads() {
        coEvery { profileRepo.getAIConfigPreferences("cust-1") } returns null
    }

    @Test
    fun `an account that never agreed is asked and its AI backfill waits`() = runTest {
        existingProfile()
        stubBootstrapReads()

        val response = service.onboardAndBootstrap(sub, client, null, "John", null)

        assertEquals(true, response.aiDataConsentRequired)
        assertNull(response.aiDataConsentAt)
        verify(exactly = 0) { instructionService.backfillInstructionsAsync(any(), any()) }
    }

    @Test
    fun `an account on the current version is not asked and its AI backfill runs`() = runTest {
        existingProfile(
            "aiDataConsentVersion" to n(CURRENT_AI_DATA_CONSENT_VERSION),
            "aiDataConsentAt" to s("2026-11-08T21:00:00Z")
        )
        stubBootstrapReads()

        val response = service.onboardAndBootstrap(sub, client, null, "John", null)

        assertEquals(false, response.aiDataConsentRequired)
        assertEquals("2026-11-08T21:00:00Z", response.aiDataConsentAt)
        verify(exactly = 1) { instructionService.backfillInstructionsAsync("cust-1", any()) }
    }

    @Test
    fun `an older version is asked again`() = runTest {
        existingProfile("aiDataConsentVersion" to n(CURRENT_AI_DATA_CONSENT_VERSION - 1))
        stubBootstrapReads()

        assertEquals(true, service.onboardAndBootstrap(sub, client, null, "John", null).aiDataConsentRequired)
    }

    @Test
    fun `the admin panel is never asked`() = runTest {
        coEvery { profileRepo.getCustomerProfile(sub, "ADMIN_PANEL") } returns mapOf("customerId" to s("cust-1"))
        stubBootstrapReads()

        val response = service.onboardAndBootstrap(sub, "ADMIN_PANEL", null, "John", null)

        assertEquals(false, response.aiDataConsentRequired)
    }

    @Test
    fun `accepting stores the current version with a UTC timestamp`() = runTest {
        val stored = slot<String>()
        coEvery {
            profileRepo.recordAiDataConsent(sub, client, CURRENT_AI_DATA_CONSENT_VERSION, capture(stored))
        } returns UpdateItemResponse.builder().build()

        val acceptedAt = service.acceptAiDataConsent(sub, client)

        assertEquals(acceptedAt, stored.captured)
        assertTrue(acceptedAt.endsWith("Z"))
    }

    @Test
    fun `hasAiDataConsent follows the stored version`() = runTest {
        coEvery { profileRepo.getAiDataConsent(sub, client) } returns mapOf("customerId" to s("cust-1"))
        assertFalse(service.hasAiDataConsent(sub, "azp"))

        coEvery { profileRepo.getAiDataConsent(sub, client) } returns mapOf(
            "customerId" to s("cust-1"),
            "aiDataConsentVersion" to n(CURRENT_AI_DATA_CONSENT_VERSION)
        )
        assertTrue(service.hasAiDataConsent(sub, "azp"))
    }

    @Test
    fun `an identity with no customer-app account isn't held to consent`() = runTest {
        coEvery { profileRepo.getAiDataConsent(sub, client) } returns null

        assertTrue(service.hasAiDataConsent(sub, "azp"))
    }

    @Test
    fun `an admin panel token isn't held to consent`() = runTest {
        every { appConfig.clientAppForAzp("admin-azp") } returns AppConfig.CLIENT_ADMIN_PANEL

        assertTrue(service.hasAiDataConsent(sub, "admin-azp"))
        coVerify(exactly = 0) { profileRepo.getAiDataConsent(any(), any()) }
    }
}
