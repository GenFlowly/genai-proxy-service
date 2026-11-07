package com.genflowly.service

import com.genflowly.models.api.InstructionUsageConversation
import com.genflowly.models.api.InstructionUsageResponse
import com.genflowly.repository.InstructionRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

class InstructionNotFoundException(instructionId: String) : Exception("Instruction $instructionId not found")

/**
 * How the caller has used an instruction: in how many conversations, when
 * last, and which ones. Usage is per caller, so an owner never sees the
 * conversations of the people it is shared with.
 */
class InstructionUsageService(
    private val instructionRepository: InstructionRepository,
    private val instructionService: InstructionService,
    private val conversationService: ConversationService,
) {

    suspend fun getUsage(customerId: String, instructionId: String): InstructionUsageResponse {
        val latest = instructionRepository.getLatestInstructionVersion(instructionId)
            ?: throw InstructionNotFoundException(instructionId)
        instructionService.getInstructionVersion(customerId, instructionId, latest)
            ?: throw InstructionNotFoundException(instructionId)

        val count = instructionRepository.getInstructionUsage(customerId, instructionId)
        val allUses = instructionRepository.getInstructionConversations(customerId, instructionId)
            .sortedWith(compareByDescending(nullsFirst()) { it.seenAt })
        val uses = allUses.take(MAX_CONVERSATIONS)
        val conversations = coroutineScope {
            uses.map { use ->
                async {
                    try {
                        InstructionUsageConversation(
                            conversationId = use.conversationId,
                            title = conversationService.getConversationTitle(use.conversationId, customerId),
                            firstUsedAt = use.seenAt
                        )
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: ConversationAccessDeniedException) {
                        null
                    }
                }
            }.awaitAll().filterNotNull()
        }
        return InstructionUsageResponse(
            usageCount = maxOf(count?.count ?: 0, conversations.size),
            lastUsedAt = count?.lastUsedAt,
            conversations = conversations,
            omitted = allUses.size - uses.size
        )
    }

    private companion object {
        const val MAX_CONVERSATIONS = 50
    }
}
