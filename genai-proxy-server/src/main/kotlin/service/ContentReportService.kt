package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.models.ShareRole
import com.genflowly.models.api.ContentReportResponse
import com.genflowly.models.api.CreateContentReportRequest
import com.genflowly.models.api.ListContentReportsResponse
import com.genflowly.models.api.ReportAction
import com.genflowly.models.api.ReportResolution
import com.genflowly.models.api.ReportStatus
import com.genflowly.models.api.ReportedEntityType
import com.genflowly.models.api.ResolveContentReportRequest
import com.genflowly.models.api.SharedItemOwnerResponse
import com.genflowly.providers.SnsNotifier
import com.genflowly.repository.ContentReportRepository
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.PurgeRepository
import com.genflowly.repository.ShareRepository
import java.time.Instant
import kotlinx.coroutines.CancellationException
import org.slf4j.LoggerFactory

class ReportNotAllowedException : Exception("You can't report this item.")
class ReportNotFoundException : Exception("Report not found")
class ReportAlreadyResolvedException : Exception("This report has already been resolved.")

/** Reports of items shared with someone, and what an admin does about them. */
class ContentReportService(
    private val reportRepository: ContentReportRepository,
    private val conversationService: ConversationService,
    private val conversationRepository: ConversationRepository,
    private val instructionService: InstructionService,
    private val instructionRepository: InstructionRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val purgeRepository: PurgeRepository,
    private val shareRepository: ShareRepository,
    private val snsNotifier: SnsNotifier,
    private val clock: () -> Instant = Instant::now
) {
    private val logger = LoggerFactory.getLogger(ContentReportService::class.java)

    /** False when this person had already reported the item. */
    suspend fun createReport(reporterCustomerId: String, request: CreateContentReportRequest): Boolean {
        val details = request.details?.trim()?.takeIf { it.isNotEmpty() }
        require((details?.length ?: 0) <= MAX_DETAILS_CHARS) { "Details can be at most $MAX_DETAILS_CHARS characters." }
        val ownerId = ownerIfReportable(request.entityType, request.entityId, reporterCustomerId)
        val content = snapshot(request.entityType, request.entityId, ownerId, request.messageId)

        val report = ContentReportResponse(
            entityId = request.entityId,
            entityType = request.entityType,
            messageId = request.messageId,
            title = content.title,
            ownerCustomerId = ownerId,
            ownerUsername = usernameOf(ownerId),
            reporterCustomerId = reporterCustomerId,
            reporterUsername = usernameOf(reporterCustomerId),
            reason = request.reason,
            details = details,
            contentSnapshot = content.text,
            status = ReportStatus.OPEN,
            createdAt = clock().toString()
        )
        val created = reportRepository.createIfAbsent(report)
        if (created) emailSupport(report)
        return created
    }

    suspend fun ownerOfSharedItem(callerCustomerId: String, entityType: ReportedEntityType, entityId: String): SharedItemOwnerResponse {
        val ownerId = ownerIfReportable(entityType, entityId, callerCustomerId)
        val profile = customerProfileRepository.getCustomerProfileByCustomerId(ownerId)
        return SharedItemOwnerResponse(
            ownerCustomerId = ownerId,
            ownerUsername = profile?.get(DynamoDBConstants.USERNAME_KEY)?.s(),
            ownerName = profile?.get("name")?.s(),
            canBlock = profile != null,
            canRemove = when (entityType) {
                ReportedEntityType.CONVERSATION -> shareRepository.getConversationShare(entityId, callerCustomerId) != null
                ReportedEntityType.INSTRUCTION -> shareRepository.getSharesForEntity(entityId).any { it.first == callerCustomerId }
            },
            alreadyReported = reportRepository.exists(entityId, callerCustomerId)
        )
    }

    suspend fun listReports(status: ReportStatus, limit: Int, cursor: String?): ListContentReportsResponse {
        val page = reportRepository.list(status, limit.coerceIn(1, MAX_PAGE_SIZE), cursor)
        return ListContentReportsResponse(page.reports, page.nextCursor, reportRepository.countOpen())
    }

    suspend fun resolveReport(
        adminCustomerId: String,
        entityId: String,
        reporterCustomerId: String,
        request: ResolveContentReportRequest
    ) {
        val report = reportRepository.get(entityId, reporterCustomerId) ?: throw ReportNotFoundException()
        val note = request.note?.trim()?.takeIf { it.isNotEmpty() }
        val now = clock().toString()
        when (request.action) {
            ReportAction.DISMISS -> resolve(report, ReportResolution.DISMISSED, note, adminCustomerId, now)
            ReportAction.RESOLVE -> resolve(report, ReportResolution.RESOLVED, note, adminCustomerId, now)
            ReportAction.MAKE_PRIVATE -> {
                if (report.status != ReportStatus.OPEN) throw ReportAlreadyResolvedException()
                when (report.entityType) {
                    ReportedEntityType.CONVERSATION -> purgeRepository.deleteConversationShares(entityId)
                    ReportedEntityType.INSTRUCTION -> purgeRepository.deleteEntityShares(entityId)
                }
                reportRepository.reporterIdsFor(entityId).forEach { reporter ->
                    reportRepository.resolveIfOpen(entityId, reporter, ReportResolution.MADE_PRIVATE, note, adminCustomerId, now)
                }
            }
        }
        logger.info("Admin {} applied {} to the report on {}", adminCustomerId, request.action, entityId)
    }

    private suspend fun resolve(report: ContentReportResponse, resolution: ReportResolution, note: String?, admin: String, now: String) {
        val updated = reportRepository.resolveIfOpen(report.entityId, report.reporterCustomerId, resolution, note, admin, now)
        if (!updated) throw ReportAlreadyResolvedException()
    }

    /** The item's owner, when [customerId] can see the item and doesn't own it. */
    private suspend fun ownerIfReportable(entityType: ReportedEntityType, entityId: String, customerId: String): String {
        val role: ShareRole?
        val ownerId: String?
        when (entityType) {
            ReportedEntityType.CONVERSATION -> {
                role = conversationService.getConversationRole(entityId, customerId)
                ownerId = conversationRepository.getConversationById(entityId)?.customerId
            }
            ReportedEntityType.INSTRUCTION -> {
                val latest = instructionRepository.getLatestInstructionVersion(entityId)
                role = latest?.let { instructionService.getInstructionVersion(customerId, entityId, it)?.role }
                ownerId = latest?.let { instructionRepository.getInstruction(entityId, it)?.creator }
            }
        }
        if (role == null || role == ShareRole.OWNER || ownerId == null) throw ReportNotAllowedException()
        return ownerId
    }

    private data class Snapshot(val title: String?, val text: String)

    private suspend fun snapshot(entityType: ReportedEntityType, entityId: String, ownerId: String, messageId: String?): Snapshot =
        when (entityType) {
            ReportedEntityType.CONVERSATION -> {
                val messages = conversationRepository.getMessagesForConversation(entityId).sortedBy { it.sequence }
                val reported = messageId?.let { id -> messages.firstOrNull { it.messageId == id } }
                val recentFirst = buildList {
                    reported?.let { add("Reported message: ${it.text}") }
                    messages.asReversed().filter { it !== reported }.forEach { add("${it.role}: ${it.text}") }
                }
                var remaining = MAX_SNAPSHOT_CHARS
                val kept = recentFirst.takeWhile { line ->
                    val fits = remaining > 0
                    remaining -= line.length
                    fits
                }
                Snapshot(
                    conversationRepository.getConversationTitle(entityId, ownerId),
                    kept.joinToString("\n\n").take(MAX_SNAPSHOT_CHARS)
                )
            }
            ReportedEntityType.INSTRUCTION -> {
                val latest = instructionRepository.getLatestInstructionVersion(entityId)
                val instruction = latest?.let { instructionRepository.getInstruction(entityId, it) }
                Snapshot(instruction?.name, instruction?.instructions.orEmpty().take(MAX_SNAPSHOT_CHARS))
            }
        }

    private suspend fun usernameOf(customerId: String): String? =
        customerProfileRepository.getCustomerProfileByCustomerId(customerId)?.get(DynamoDBConstants.USERNAME_KEY)?.s()

    // The report is already stored and shows in the admin panel, so a failed email must not fail the request.
    private suspend fun emailSupport(report: ContentReportResponse) {
        try {
            snsNotifier.notifySupport(
                subject = "[Report] ${report.entityType.name.lowercase()} ${report.reason.name.lowercase()}",
                message = buildString {
                    appendLine("A ${report.entityType.name.lowercase()} was reported. Open the admin panel's Reports page to act on it.")
                    appendLine()
                    appendLine("Reason: ${report.reason}")
                    appendLine("Item: ${report.title ?: "(untitled)"} (${report.entityId})")
                    appendLine("Owner: ${report.ownerUsername ?: "unknown"} (${report.ownerCustomerId})")
                    appendLine("Reporter: ${report.reporterUsername ?: "unknown"} (${report.reporterCustomerId})")
                    report.details?.let { appendLine("Details: $it") }
                    appendLine()
                    appendLine(report.contentSnapshot.take(MAX_EMAIL_SNAPSHOT_CHARS))
                }
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.error("Failed to email the report on {}", report.entityId, e)
        }
    }

    companion object {
        const val MAX_DETAILS_CHARS = 1000
        const val MAX_PAGE_SIZE = 100
        private const val MAX_SNAPSHOT_CHARS = 8000
        private const val MAX_EMAIL_SNAPSHOT_CHARS = 2000
    }
}
