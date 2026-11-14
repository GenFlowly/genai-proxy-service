package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
enum class ReportedEntityType { CONVERSATION, INSTRUCTION }

@Serializable
enum class ReportReason { SPAM, HARASSMENT, HATE, SEXUAL, VIOLENCE, ILLEGAL, OTHER }

@Serializable
enum class ReportStatus { OPEN, RESOLVED }

@Serializable
enum class ReportResolution { DISMISSED, MADE_PRIVATE, RESOLVED }

@Serializable
enum class ReportAction { DISMISS, MAKE_PRIVATE, RESOLVE }

@Serializable
data class CreateContentReportRequest(
    val entityType: ReportedEntityType,
    val entityId: String,
    val messageId: String? = null,
    val reason: ReportReason,
    val details: String? = null
)

@Serializable
data class CreateContentReportResponse(
    /** False when this person had already reported the item; the first report stands. */
    val created: Boolean
)

/** Who owns an item shared with the caller, which the Report and Block actions name. */
@Serializable
data class SharedItemOwnerResponse(
    val ownerCustomerId: String,
    val ownerUsername: String? = null,
    val ownerName: String? = null,
    /** False for items with no person behind them, such as System instructions. */
    val canBlock: Boolean,
    /** True when the item was shared with the caller directly, so it can leave their list. A public item can't. */
    val canRemove: Boolean,
    val alreadyReported: Boolean
)

@Serializable
data class CreateBlockRequest(val customerId: String)

@Serializable
data class BlockedUserResponse(
    val customerId: String,
    val username: String? = null,
    val name: String? = null,
    val blockedAt: String
)

@Serializable
data class ContentReportResponse(
    val entityId: String,
    val entityType: ReportedEntityType,
    val messageId: String? = null,
    val title: String? = null,
    val ownerCustomerId: String? = null,
    val ownerUsername: String? = null,
    val reporterCustomerId: String,
    val reporterUsername: String? = null,
    val reason: ReportReason,
    val details: String? = null,
    val contentSnapshot: String,
    val status: ReportStatus,
    val createdAt: String,
    val resolvedAt: String? = null,
    val resolvedBy: String? = null,
    val resolution: ReportResolution? = null,
    val resolutionNote: String? = null
)

@Serializable
data class ListContentReportsResponse(
    val reports: List<ContentReportResponse>,
    val nextCursor: String? = null,
    val openCount: Int
)

@Serializable
data class ResolveContentReportRequest(
    val action: ReportAction,
    val note: String? = null
)
