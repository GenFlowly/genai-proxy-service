package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Characterization tests for username generation/reservation (slugify + random
 * suffix + conditional-put retry) and the lazy username backfill that mutates a
 * profile on read. Locks in the write-on-read behavior before the policy
 * ascends from the provider into CustomerProfileService.
 */
class UsernameGenerationTest {

    private val client = mockk<DynamoDbClient>()
    private val provider = CustomerProfileRepository(client, mockk<KLogger>(relaxed = true))

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    private val usernamePattern = Regex("^johndoe-[0-9a-f]{6}$")

    @Test
    fun `onboarding slugifies the name, reserves it conditionally, and writes the profile`() = runTest {
        val puts = mutableListOf<PutItemRequest>()
        every { client.putItem(capture(puts)) } returns PutItemResponse.builder().build()

        val username = provider.onboardCustomer(
            sub = "auth0|abc", client = "REACT_APP", customerId = "cust-1",
            email = "j@example.com", name = "John Doe!", picture = null
        )

        assertTrue(usernamePattern.matches(username), "unexpected username: $username")

        val reservation = puts.first { it.tableName() == "UsernameLookup" }
        assertEquals(username, reservation.item()["username"]?.s())
        assertEquals("USER", reservation.item()["recordType"]?.s())
        assertEquals("cust-1", reservation.item()["customerId"]?.s())
        assertTrue(reservation.conditionExpression()!!.contains("attribute_not_exists(username)"))

        val profile = puts.first { it.tableName() == DynamoDBConstants.CUSTOMER_PROFILE_TABLE }
        assertEquals(username, profile.item()["username"]?.s())
        assertEquals(false, profile.item()["isDiscoverable"]?.bool())
        assertEquals(false, profile.item()["onboardingCompleted"]?.bool())
        assertTrue(profile.item().containsKey("createdAt"))
    }

    @Test
    fun `collision on reservation retries with a fresh suffix`() = runTest {
        val reservations = mutableListOf<String>()
        var lookupCalls = 0
        every { client.putItem(any<PutItemRequest>()) } answers {
            val req = firstArg<PutItemRequest>()
            if (req.tableName() == "UsernameLookup") {
                lookupCalls++
                reservations.add(req.item()["username"]!!.s())
                if (lookupCalls == 1) throw ConditionalCheckFailedException.builder().message("taken").build()
            }
            PutItemResponse.builder().build()
        }

        val username = provider.onboardCustomer(
            sub = "auth0|abc", client = "REACT_APP", customerId = "cust-1",
            email = null, name = "John Doe", picture = null
        )

        assertEquals(2, lookupCalls)
        assertEquals(reservations[1], username) // second attempt won
        assertTrue(reservations[0] != reservations[1])
    }

    @Test
    fun `three collisions exhaust retries and abort onboarding`() = runTest {
        var profileWrites = 0
        every { client.putItem(any<PutItemRequest>()) } answers {
            val req = firstArg<PutItemRequest>()
            if (req.tableName() == "UsernameLookup") {
                throw ConditionalCheckFailedException.builder().message("taken").build()
            }
            profileWrites++
            PutItemResponse.builder().build()
        }

        assertFailsWith<IllegalStateException> {
            provider.onboardCustomer("auth0|abc", "REACT_APP", "cust-1", null, "John", null)
        }
        assertEquals(0, profileWrites) // no profile row without a reserved username
    }

    @Test
    fun `null or unusable name falls back to user base slug`() = runTest {
        every { client.putItem(any<PutItemRequest>()) } returns PutItemResponse.builder().build()

        val username = provider.onboardCustomer("auth0|abc", "REACT_APP", "cust-1", null, name = "!!!", picture = null)

        assertTrue(Regex("^user-[0-9a-f]{6}$").matches(username), "unexpected username: $username")
    }

    @Test
    fun `profile read without username lazily generates, persists, and returns it`() = runTest {
        val puts = mutableListOf<PutItemRequest>()
        val updates = mutableListOf<UpdateItemRequest>()
        every { client.putItem(capture(puts)) } returns PutItemResponse.builder().build()
        every { client.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()
        every { client.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().item(mapOf(
            DynamoDBConstants.SUB_PARTITION_KEY to s("auth0|abc"),
            DynamoDBConstants.CLIENT_SORT_KEY to s("REACT_APP"),
            "customerId" to s("cust-1"),
            "name" to s("John Doe")
        )).build()

        val item = provider.getCustomerProfile("auth0|abc", "REACT_APP")!!

        // A username was reserved and stamped onto the profile row via UpdateItem
        assertEquals(1, puts.count { it.tableName() == "UsernameLookup" })
        assertEquals(1, updates.size)
        val expr = updates[0].updateExpression()!!
        assertTrue(expr.contains("SET username = :u"))
        assertTrue(expr.contains("if_not_exists(isDiscoverable, :d)"))

        // The returned item reflects the backfill without a re-read
        val returned = item["username"]?.s()
        assertTrue(usernamePattern.matches(returned!!), "unexpected username: $returned")
        assertEquals(false, item["isDiscoverable"]?.bool())
    }

    @Test
    fun `profile read with existing username does not write anything`() = runTest {
        var writes = 0
        every { client.putItem(any<PutItemRequest>()) } answers { writes++; PutItemResponse.builder().build() }
        every { client.updateItem(any<UpdateItemRequest>()) } answers { writes++; UpdateItemResponse.builder().build() }
        every { client.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().item(mapOf(
            "customerId" to s("cust-1"),
            "username" to s("existing-user")
        )).build()

        val item = provider.getCustomerProfile("auth0|abc", "REACT_APP")!!

        assertEquals("existing-user", item["username"]?.s())
        assertEquals(0, writes)
    }

    @Test
    fun `markOnboardingCompleted flips the flag to true`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { client.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        provider.markOnboardingCompleted("auth0|abc", "REACT_APP")

        assertEquals(1, updates.size)
        assertTrue(updates[0].updateExpression()!!.contains("SET onboardingCompleted = :c"))
        assertEquals(true, updates[0].expressionAttributeValues()[":c"]?.bool())
    }
}
