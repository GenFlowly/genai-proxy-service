package com.genflowly.repository

import com.genflowly.DynamoDBConstants.CONTENT_REPORTS_STATUS_GSI
import com.genflowly.DynamoDBConstants.CONTENT_REPORTS_TABLE
import com.genflowly.DynamoDBConstants.CREATED_AT_KEY
import com.genflowly.DynamoDBConstants.ENTITY_ID_KEY
import com.genflowly.DynamoDBConstants.REPORTER_CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.REPORT_STATUS_KEY
import com.genflowly.models.api.ContentReportResponse
import com.genflowly.models.api.ReportReason
import com.genflowly.models.api.ReportResolution
import com.genflowly.models.api.ReportStatus
import com.genflowly.models.api.ReportedEntityType
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.Select
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

data class ContentReportPage(val reports: List<ContentReportResponse>, val nextCursor: String?)

class ContentReportRepository(private val dynamoDbClient: DynamoDbClient) {

    /** False when this reporter has already reported this item; the first report stands. */
    suspend fun createIfAbsent(report: ContentReportResponse): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(CONTENT_REPORTS_TABLE)
                    .item(toItem(report))
                    .conditionExpression("attribute_not_exists($ENTITY_ID_KEY)")
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    suspend fun exists(entityId: String, reporterCustomerId: String): Boolean = get(entityId, reporterCustomerId) != null

    suspend fun get(entityId: String, reporterCustomerId: String): ContentReportResponse? = withContext(Dispatchers.IO) {
        val item = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(CONTENT_REPORTS_TABLE)
                .key(key(entityId, reporterCustomerId))
                .consistentRead(true)
                .build()
        ).item()
        item.takeIf { it.isNotEmpty() }?.let(::fromItem)
    }

    /** One page of [status], newest first. The cost follows [limit], not the size of the table. */
    suspend fun list(status: ReportStatus, limit: Int, cursor: String?): ContentReportPage = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.query(
            QueryRequest.builder()
                .tableName(CONTENT_REPORTS_TABLE)
                .indexName(CONTENT_REPORTS_STATUS_GSI)
                .keyConditionExpression("#status = :status")
                .expressionAttributeNames(mapOf("#status" to REPORT_STATUS_KEY))
                .expressionAttributeValues(mapOf(":status" to s(status.name)))
                .scanIndexForward(false)
                .limit(limit)
                .apply { if (cursor != null) exclusiveStartKey(decodeCursor(cursor)) }
                .build()
        )
        val next = response.lastEvaluatedKey().takeIf { response.hasLastEvaluatedKey() && it.isNotEmpty() }
        ContentReportPage(response.items().map(::fromItem), next?.let(::encodeCursor))
    }

    /** Reads only the open rows, which stay few because resolving a report moves it out of this partition. */
    suspend fun countOpen(): Int = withContext(Dispatchers.IO) {
        dynamoDbClient.queryPaginator(
            QueryRequest.builder()
                .tableName(CONTENT_REPORTS_TABLE)
                .indexName(CONTENT_REPORTS_STATUS_GSI)
                .keyConditionExpression("#status = :status")
                .expressionAttributeNames(mapOf("#status" to REPORT_STATUS_KEY))
                .expressionAttributeValues(mapOf(":status" to s(ReportStatus.OPEN.name)))
                .select(Select.COUNT)
                .build()
        ).stream().mapToInt { it.count() }.sum()
    }

    suspend fun reporterIdsFor(entityId: String): List<String> = withContext(Dispatchers.IO) {
        dynamoDbClient.queryPaginator(
            QueryRequest.builder()
                .tableName(CONTENT_REPORTS_TABLE)
                .keyConditionExpression("$ENTITY_ID_KEY = :id")
                .expressionAttributeValues(mapOf(":id" to s(entityId)))
                .projectionExpression(REPORTER_CUSTOMER_ID_KEY)
                .build()
        ).items().mapNotNull { it[REPORTER_CUSTOMER_ID_KEY]?.s() }.toList()
    }

    /** False when the report wasn't open any more. */
    suspend fun resolveIfOpen(
        entityId: String,
        reporterCustomerId: String,
        resolution: ReportResolution,
        note: String?,
        resolvedBy: String,
        resolvedAt: String
    ): Boolean = withContext(Dispatchers.IO) {
        val values = buildMap {
            put(":open", s(ReportStatus.OPEN.name))
            put(":resolved", s(ReportStatus.RESOLVED.name))
            put(":resolution", s(resolution.name))
            put(":by", s(resolvedBy))
            put(":at", s(resolvedAt))
            if (note != null) put(":note", s(note))
        }
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONTENT_REPORTS_TABLE)
                    .key(key(entityId, reporterCustomerId))
                    .updateExpression(
                        "SET #status = :resolved, $RESOLUTION = :resolution, $RESOLVED_BY = :by, $RESOLVED_AT = :at" +
                            if (note != null) ", $RESOLUTION_NOTE = :note" else ""
                    )
                    .conditionExpression("#status = :open")
                    .expressionAttributeNames(mapOf("#status" to REPORT_STATUS_KEY))
                    .expressionAttributeValues(values)
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    private fun toItem(report: ContentReportResponse): Map<String, AttributeValue> = buildMap {
        put(ENTITY_ID_KEY, s(report.entityId))
        put(REPORTER_CUSTOMER_ID_KEY, s(report.reporterCustomerId))
        put(ENTITY_TYPE, s(report.entityType.name))
        put(REASON, s(report.reason.name))
        put(CONTENT_SNAPSHOT, s(report.contentSnapshot))
        put(REPORT_STATUS_KEY, s(report.status.name))
        put(CREATED_AT_KEY, s(report.createdAt))
        report.messageId?.let { put(MESSAGE_ID, s(it)) }
        report.title?.let { put(TITLE, s(it)) }
        report.ownerCustomerId?.let { put(OWNER_ID, s(it)) }
        report.ownerUsername?.let { put(OWNER_USERNAME, s(it)) }
        report.reporterUsername?.let { put(REPORTER_USERNAME, s(it)) }
        report.details?.let { put(DETAILS, s(it)) }
    }

    private fun fromItem(item: Map<String, AttributeValue>): ContentReportResponse =
        ContentReportResponse(
            entityId = item.getValue(ENTITY_ID_KEY).s(),
            entityType = ReportedEntityType.valueOf(item.getValue(ENTITY_TYPE).s()),
            messageId = item[MESSAGE_ID]?.s(),
            title = item[TITLE]?.s(),
            ownerCustomerId = item[OWNER_ID]?.s(),
            ownerUsername = item[OWNER_USERNAME]?.s(),
            reporterCustomerId = item.getValue(REPORTER_CUSTOMER_ID_KEY).s(),
            reporterUsername = item[REPORTER_USERNAME]?.s(),
            reason = ReportReason.valueOf(item.getValue(REASON).s()),
            details = item[DETAILS]?.s(),
            contentSnapshot = item[CONTENT_SNAPSHOT]?.s().orEmpty(),
            status = ReportStatus.valueOf(item.getValue(REPORT_STATUS_KEY).s()),
            createdAt = item[CREATED_AT_KEY]?.s().orEmpty(),
            resolvedAt = item[RESOLVED_AT]?.s(),
            resolvedBy = item[RESOLVED_BY]?.s(),
            resolution = item[RESOLUTION]?.s()?.let(ReportResolution::valueOf),
            resolutionNote = item[RESOLUTION_NOTE]?.s()
        )

    private fun key(entityId: String, reporterCustomerId: String): Map<String, AttributeValue> =
        mapOf(ENTITY_ID_KEY to s(entityId), REPORTER_CUSTOMER_ID_KEY to s(reporterCustomerId))

    private fun encodeCursor(key: Map<String, AttributeValue>): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(
            Json.encodeToString(CURSOR_SERIALIZER, key.mapValues { it.value.s() }).toByteArray()
        )

    private fun decodeCursor(cursor: String): Map<String, AttributeValue> =
        try {
            Json.decodeFromString(CURSOR_SERIALIZER, String(Base64.getUrlDecoder().decode(cursor)))
                .mapValues { s(it.value) }
        } catch (e: Exception) {
            throw IllegalArgumentException("Invalid cursor")
        }

    private fun s(value: String): AttributeValue = AttributeValue.builder().s(value).build()

    private companion object {
        val CURSOR_SERIALIZER = kotlinx.serialization.builtins.MapSerializer(
            kotlinx.serialization.serializer<String>(), kotlinx.serialization.serializer<String>()
        )
        const val ENTITY_TYPE = "entityType"
        const val MESSAGE_ID = "messageId"
        const val TITLE = "title"
        const val OWNER_ID = "ownerCustomerId"
        const val OWNER_USERNAME = "ownerUsername"
        const val REPORTER_USERNAME = "reporterUsername"
        const val REASON = "reason"
        const val DETAILS = "details"
        const val CONTENT_SNAPSHOT = "contentSnapshot"
        const val RESOLVED_AT = "resolvedAt"
        const val RESOLVED_BY = "resolvedBy"
        const val RESOLUTION = "resolution"
        const val RESOLUTION_NOTE = "resolutionNote"
    }
}
