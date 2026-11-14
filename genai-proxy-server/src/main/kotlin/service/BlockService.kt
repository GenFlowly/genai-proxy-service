package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.models.api.BlockedUserResponse
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerBlock
import com.genflowly.repository.CustomerBlockRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.PurgeRepository
import com.genflowly.repository.ShareRepository
import java.time.Instant
import org.slf4j.LoggerFactory

class UserBlockedException : Exception("You can't share with this user.")
class BlockTargetNotFoundException : Exception("User not found")

/**
 * Blocking works both ways: neither side can find the other by username or
 * share with the other, and each other's public items are hidden from them
 * while signed in. Creating a block removes every existing share between them.
 */
class BlockService(
    private val blockRepository: CustomerBlockRepository,
    private val shareRepository: ShareRepository,
    private val purgeRepository: PurgeRepository,
    private val conversationRepository: ConversationRepository,
    private val instructionRepository: InstructionRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val clock: () -> Instant = Instant::now
) {
    private val logger = LoggerFactory.getLogger(BlockService::class.java)

    suspend fun block(blockerCustomerId: String, blockedCustomerId: String) {
        require(blockedCustomerId != blockerCustomerId) { "You can't block yourself." }
        require(blockedCustomerId != PUBLIC) { "That isn't a user." }
        val profile = customerProfileRepository.getCustomerProfileByCustomerId(blockedCustomerId)
            ?: throw BlockTargetNotFoundException()

        blockRepository.block(
            CustomerBlock(
                blockerCustomerId = blockerCustomerId,
                blockedCustomerId = blockedCustomerId,
                blockedUsername = profile[DynamoDBConstants.USERNAME_KEY]?.s(),
                blockedName = profile["name"]?.s(),
                createdAt = clock().toString()
            )
        )
        removeShares(from = blockerCustomerId, to = blockedCustomerId)
        removeShares(from = blockedCustomerId, to = blockerCustomerId)
        logger.info("Customer {} blocked {}", blockerCustomerId, blockedCustomerId)
    }

    suspend fun unblock(blockerCustomerId: String, blockedCustomerId: String) =
        blockRepository.unblock(blockerCustomerId, blockedCustomerId)

    suspend fun blockedUsers(blockerCustomerId: String): List<BlockedUserResponse> =
        blockRepository.blocksBy(blockerCustomerId)
            .sortedByDescending { it.createdAt }
            .map { BlockedUserResponse(it.blockedCustomerId, it.blockedUsername, it.blockedName, it.createdAt) }

    /** Throws when either customer has blocked the other. The PUBLIC pseudo-customer is never blocked. */
    suspend fun ensureNotBlocked(a: String, b: String) {
        if (a == PUBLIC || b == PUBLIC || a == b) return
        if (blockRepository.isBlockedEitherWay(a, b)) throw UserBlockedException()
    }

    suspend fun isBlockedEitherWay(a: String, b: String): Boolean = blockRepository.isBlockedEitherWay(a, b)

    suspend fun relatedCustomerIds(customerId: String): Set<String> = blockRepository.relatedCustomerIds(customerId)

    /** Removes what [to] received from [from], whether [from] owns the item or shared someone else's. */
    private suspend fun removeShares(from: String, to: String) {
        val conversations = shareRepository.conversationSharesWith(to)
            .filter { it.sharedBy == from || conversationRepository.getConversationById(it.entityId)?.customerId == from }
            .map { it.entityId }
        purgeRepository.deleteConversationSharesWith(to, conversations)

        val instructions = shareRepository.entitySharesWith(to)
            .filter { it.sharedBy == from || instructionCreator(it.entityId) == from }
            .map { it.entityId }
        purgeRepository.deleteEntitySharesWith(to, instructions)
    }

    private suspend fun instructionCreator(instructionId: String): String? =
        instructionRepository.getLatestInstructionVersion(instructionId)
            ?.let { instructionRepository.getInstruction(instructionId, it) }
            ?.creator

    private companion object {
        const val PUBLIC = "PUBLIC"
    }
}
