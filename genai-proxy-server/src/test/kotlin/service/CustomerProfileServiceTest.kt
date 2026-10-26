package com.genflowly.service

import com.genflowly.config.AppConfig
import com.genflowly.repository.CustomerProfileRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals

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
    private val service = CustomerProfileService(profileRepo, credentialsService, instructionService, appConfig)

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
}
