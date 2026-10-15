package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.models.ShareRole
import com.genflowly.service.ConversationService
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A durable run's pending entry lives on the conversation OWNER's row (3.9),
 * also when a share recipient's turn started it: that is the row reload
 * rediscovery, reattach authorization and the purge read. No write ever
 * creates a Conversation row under someone else's key.
 */
class PendingRunOwnerRowTest {

    private val client = mockk<DynamoDbClient>()
    private val repository = ConversationRepository(client, mockk<KLogger>(relaxed = true))
    private val updates = mutableListOf<UpdateItemRequest>()
    private val run = PendingRun("resp-1", "run_1", "OPENAI", "model-x")

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    /** A table holding one conversation, conv-1, owned by [owner]. */
    private fun tableWithConversationOwnedBy(owner: String?) {
        every { client.updateItem(any<UpdateItemRequest>()) } answers {
            val request = firstArg<UpdateItemRequest>()
            updates += request
            if (owner == null || request.key()[DynamoDBConstants.CUSTOMER_ID_KEY]?.s() != owner) {
                throw ConditionalCheckFailedException.builder().message("The conditional request failed").build()
            }
            UpdateItemResponse.builder().build()
        }
        every { client.query(any<QueryRequest>()) } returns QueryResponse.builder().items(
            listOfNotNull(owner?.let {
                mapOf(
                    DynamoDBConstants.CUSTOMER_ID_KEY to s(it),
                    DynamoDBConstants.CONVERSATION_ID_KEY to s("conv-1"),
                    "client" to s("REACT_APP")
                )
            })
        ).build()
    }

    private fun UpdateItemRequest.customerId() = key()[DynamoDBConstants.CUSTOMER_ID_KEY]?.s()

    @Test
    fun `the owner's own turn writes the owner's row without a lookup`() = runTest {
        tableWithConversationOwnedBy("owner")

        assertTrue(repository.addPendingRun("owner", "conv-1", run))

        assertEquals(listOf("owner"), updates.map { it.customerId() })
        assertEquals("ADD #pr :e", updates.single().updateExpression())
        verify(exactly = 0) { client.query(any<QueryRequest>()) }
    }

    @Test
    fun `a share recipient's turn records its run on the owner's row`() = runTest {
        tableWithConversationOwnedBy("owner")

        assertTrue(repository.addPendingRun("recipient", "conv-1", run))

        assertEquals(listOf("recipient", "owner"), updates.map { it.customerId() })
        val write = updates.last()
        assertEquals("ADD #pr :e", write.updateExpression())
        assertEquals("conv-1", write.key()[DynamoDBConstants.CONVERSATION_ID_KEY]?.s())
        assertEquals(listOf(run.encode()), write.expressionAttributeValues()[":e"]?.ss())
    }

    @Test
    fun `a share recipient's finished run is removed from the owner's row`() = runTest {
        tableWithConversationOwnedBy("owner")

        assertTrue(repository.removePendingRun("recipient", "conv-1", run))

        assertEquals(listOf("recipient", "owner"), updates.map { it.customerId() })
        assertEquals("DELETE #pr :e", updates.last().updateExpression())
    }

    @Test
    fun `every pending-run write requires the row to exist, so no phantom row is created`() = runTest {
        tableWithConversationOwnedBy("owner")

        repository.addPendingRun("recipient", "conv-1", run)
        repository.removePendingRun("recipient", "conv-1", run)

        assertTrue(updates.isNotEmpty())
        updates.forEach {
            assertEquals("attribute_exists(#cid) AND attribute_exists(#client)", it.conditionExpression())
        }
    }

    @Test
    fun `a conversation that does not exist records nothing`() = runTest {
        tableWithConversationOwnedBy(null)

        assertFalse(repository.addPendingRun("someone", "conv-1", run))
        assertFalse(repository.removePendingRun("someone", "conv-1", run))
    }

    @Test
    fun `a recipient's run is found where reattach looks for it`() = runTest {
        tableWithConversationOwnedBy("owner")
        val shares = mockk<ShareRepository>()
        every { client.getItem(any<GetItemRequest>()) } answers {
            val key = firstArg<GetItemRequest>().key()
            val onOwnersRow = key[DynamoDBConstants.CUSTOMER_ID_KEY]?.s() == "owner"
            val pending = updates.any { it.customerId() == "owner" && it.updateExpression().startsWith("ADD") }
            GetItemResponse.builder().item(
                if (onOwnersRow && pending) mapOf(DynamoDBConstants.PENDING_RUNS_KEY to AttributeValue.builder().ss(run.encode()).build())
                else emptyMap()
            ).build()
        }
        coEvery { shares.getConversationShare("conv-1", "recipient") } returns ShareRole.EDIT
        val conversations = ConversationService(repository, shares, mockk(relaxed = true), mockk(relaxed = true))

        conversations.addPendingRun("recipient", "conv-1", run)

        assertEquals(setOf("run_1"), conversations.pendingRunIdsIfAccessible("conv-1", "recipient"))
    }

    @Test
    fun `a key-only phantom row left by the old remove does not pass for the owner's row`() = runTest {
        // Before the condition existed, an unconditional remove created rows
        // holding only the key under the recipient. The condition requires the
        // conversation's client, which only the real row has.
        tableWithConversationOwnedBy("owner")

        repository.addPendingRun("recipient", "conv-1", run)

        assertTrue(updates.isNotEmpty())
        assertTrue(updates.all {
            it.conditionExpression().contains("attribute_exists(#client)") &&
                it.expressionAttributeNames()["#client"] == "client"
        })
    }

    @Test
    fun `the conversation lookup skips a phantom row, whatever order the index returns`() = runTest {
        every { client.query(any<QueryRequest>()) } returns QueryResponse.builder().items(
            mapOf(
                DynamoDBConstants.CUSTOMER_ID_KEY to s("recipient"),
                DynamoDBConstants.CONVERSATION_ID_KEY to s("conv-1")
            ),
            mapOf(
                DynamoDBConstants.CUSTOMER_ID_KEY to s("owner"),
                DynamoDBConstants.CONVERSATION_ID_KEY to s("conv-1"),
                "client" to s("REACT_APP")
            )
        ).build()

        val conversation = repository.getConversationById("conv-1")

        assertEquals("owner", conversation?.customerId)
        verify { client.query(match<QueryRequest> { it.limit() == null }) }
    }
}
