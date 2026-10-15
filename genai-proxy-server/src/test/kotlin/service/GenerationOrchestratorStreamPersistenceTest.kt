package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.ConversationRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.awscore.exception.AwsErrorDetails
import software.amazon.awssdk.services.dynamodb.model.DynamoDbException
import java.net.SocketTimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What a streamed turn relays to the browser and what it persists, for the
 * stream shapes that carry generated files.
 */
class GenerationOrchestratorStreamPersistenceTest {

    private val cust = "cust-1"
    private val aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "model-x"))

    private val instructionService = mockk<InstructionService>(relaxed = true)
    private val conversationService = mockk<ConversationService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>()
    private val retrievalService = mockk<RetrievalServerClient>()

    private val orchestrator = GenerationOrchestrator(
        credentialsService,
        instructionService,
        conversationService,
        retrievalService,
        mockk(relaxed = true),          // requestValidator
        mockk(relaxed = true),          // modelCatalogService
        mockk(relaxed = true),          // memoryService
        mockk(relaxed = true),          // costCalculationService
        mockk(relaxed = true),          // graphRepository
        AppScope(),
        mockk(relaxed = true),          // runsClient
        mockk(relaxed = true),          // appConfig (durableRunsEnabled=false: stateless path)
        mockk(relaxed = true)           // conversationManagementService
    )

    init {
        coEvery { instructionService.resolveDefaultInstruction(cust) } returns InstructionResponse(
            id = "i1", version = 1, name = "Coach", instruction = "be kind"
        )
        coEvery { conversationService.resolveWritableConversationId(cust, any(), any(), any()) } returns "conv-1"
        coEvery { credentialsService.getCustomerApiKeyForVendor(any(), cust) } returns "api-key"
    }

    private fun streamYields(chunks: Flow<StreamChunk>) {
        every {
            retrievalService.retrieveAndGenerateStream(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns chunks
    }

    /** Runs one streamed turn and returns the frames relayed to the browser, once it has persisted. */
    private suspend fun runTurn(): List<String> =
        orchestrator.processTextGenerateStreamRequest(aiConfig, "", "", "write a report", null, null, "REACT_APP", cust)
            .flow.toList()

    private fun persistedAssistantMessages(): List<Message> {
        val persisted = mutableListOf<Message>()
        coVerify(atLeast = 0) { conversationService.addMessageInConversation(capture(persisted)) }
        return persisted.filter { it.role == "assistant" }
    }

    private fun artifact(id: String, filename: String = "Report.pdf") =
        """{"artifact_id":"$id","key":"customers/cust-1/attachments/$id","media_type":"application/pdf",""" +
            """"filename":"$filename","size_bytes":13312,"source_key":"customers/cust-1/attachments/$id.source.md",""" +
            """"page_count":7}"""

    private fun ref(id: String, filename: String = "Report.pdf") = AttachmentRef(
        attachmentId = id,
        s3Key = "customers/cust-1/attachments/$id",
        mediaType = "application/pdf",
        filename = filename,
        sizeBytes = 13_312L,
        sourceKey = "customers/cust-1/attachments/$id.source.md",
        pageCount = 7
    )

    // ── 1.15 / 6.4: the browser never sees S3 keys; the message keeps them ──

    @Test
    fun `the ga frame drops the S3 keys while the persisted attachment keeps them`() = runTest {
        streamYields(flowOf(StreamChunk.GeneratedArtifacts("[${artifact("art-1")}]"), StreamChunk.Content("Here it is.")))

        val frames = runTurn()

        val ga = frames.single { it.startsWith("{\"t\":\"ga\"") }
        assertFalse("\"key\"" in ga, ga)
        assertFalse("source_key" in ga, ga)
        assertTrue("\"page_count\":7" in ga && "\"size_bytes\":13312" in ga, ga)
        assertEquals(listOf(ref("art-1")), persistedAssistantMessages().single().attachments)
    }

    // ── 1.10: a generated file is never lost on the way to the reloaded conversation ──

    @Test
    fun `a file, then content_reset, then an error frame persists the file with the fallback text`() = runTest {
        streamYields(
            flowOf(
                StreamChunk.Content("Let me write that up."),
                StreamChunk.GeneratedArtifacts("[${artifact("art-1")}]"),
                StreamChunk.ContentReset,
                StreamChunk.Error("The model provider is overloaded.", "provider_error")
            )
        )

        runTurn()

        val assistant = persistedAssistantMessages().single()
        assertEquals("Your file is attached.", assistant.text)
        assertEquals(listOf(ref("art-1")), assistant.attachments)
    }

    @Test
    fun `a file, then a socket timeout, persists the file with the fallback text`() = runTest {
        streamYields(flow {
            emit(StreamChunk.GeneratedArtifacts("[${artifact("art-1")}]"))
            throw SocketTimeoutException("Socket timeout has expired")
        })

        runTurn()

        val assistant = persistedAssistantMessages().single()
        assertEquals("Your file is attached.", assistant.text)
        assertEquals(listOf(ref("art-1")), assistant.attachments)
    }

    @Test
    fun `a file and partial text, then a failure, persists the partial text with the file`() = runTest {
        streamYields(flow {
            emit(StreamChunk.GeneratedArtifacts("[${artifact("art-1")}]"))
            emit(StreamChunk.Content("Your report covers"))
            throw SocketTimeoutException("Socket timeout has expired")
        })

        runTurn()

        val assistant = persistedAssistantMessages().single()
        assertEquals("Your report covers", assistant.text)
        assertEquals(listOf(ref("art-1")), assistant.attachments)
    }

    @Test
    fun `a failure without any generated file still persists nothing`() = runTest {
        streamYields(flow {
            emit(StreamChunk.Content("partial"))
            throw SocketTimeoutException("Socket timeout has expired")
        })

        runTurn()

        assertEquals(emptyList(), persistedAssistantMessages())
    }

    @Test
    fun `an empty generated_artifacts list is not a file`() = runTest {
        // A durable run's terminal summary always carries generated_artifacts, often [].
        streamYields(flowOf(StreamChunk.GeneratedArtifacts("[]")))

        runTurn()

        assertEquals(emptyList(), persistedAssistantMessages())
    }

    // ── 1.9: degrade persistence instead of failing ────────────────────────

    @Test
    fun `a message the store rejects for its size is stored again without its thinking steps`() = runTest {
        val repository = mockk<ConversationRepository>(relaxed = true)
        val itemTooLarge = DynamoDbException.builder()
            .message("Item size has exceeded the maximum allowed size")
            .statusCode(400)
            .awsErrorDetails(
                AwsErrorDetails.builder()
                    .errorCode("ValidationException")
                    .errorMessage("Item size has exceeded the maximum allowed size")
                    .build()
            )
            .build()
        val puts = mutableListOf<Message>()
        var rejectedOnce = false
        coEvery { repository.createMessage(capture(puts)) } answers {
            if (firstArg<Message>().role == "assistant" && !rejectedOnce) {
                rejectedOnce = true
                throw itemTooLarge
            }
        }
        // The real service between the orchestrator and the mocked repository.
        val conversations = ConversationService(repository, mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true))
        val orchestrator = GenerationOrchestrator(
            credentialsService, instructionService, conversations, retrievalService,
            mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
            mockk(relaxed = true), AppScope(), mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true)
        )
        streamYields(
            flowOf(
                StreamChunk.ThinkingStep("""{"node":"tools","name":"Tools","kind":"TOOL","status":"done"}"""),
                StreamChunk.GeneratedArtifacts("[${artifact("art-1")}]"),
                StreamChunk.Content("Here is your report.")
            )
        )

        orchestrator.processTextGenerateStreamRequest(aiConfig, "", "", "write a report", null, null, "REACT_APP", cust)
            .flow.toList()

        val (rejected, retried) = puts.filter { it.role == "assistant" }
        assertTrue(rejected.thinkingStepsJson != null)
        assertNull(retried.thinkingStepsJson)
        assertEquals(rejected.messageId, retried.messageId)
        assertEquals("Here is your report.", retried.text)
        assertEquals(listOf(ref("art-1")), retried.attachments)
    }

    @Test
    fun `artifacts the terminal summary re-sends are stored once`() = runTest {
        streamYields(
            flowOf(
                StreamChunk.GeneratedArtifacts("[${artifact("art-1")}]"),
                StreamChunk.GeneratedArtifacts("[${artifact("art-2", "Appendix.pdf")}]"),
                StreamChunk.Content("Both files are attached."),
                // the run's terminal summary: every artifact of the turn again
                StreamChunk.GeneratedArtifacts("[${artifact("art-1")},${artifact("art-2", "Appendix.pdf")}]")
            )
        )

        runTurn()

        val assistant = persistedAssistantMessages().single()
        assertEquals("Both files are attached.", assistant.text)
        assertEquals(listOf(ref("art-1"), ref("art-2", "Appendix.pdf")), assistant.attachments)
    }
}
