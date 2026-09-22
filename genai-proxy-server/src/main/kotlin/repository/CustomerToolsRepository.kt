package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_TOOLS_TABLE
import com.genflowly.models.api.CustomerTool
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest

/**
 * Data access for the CustomerTools table: the per-customer declarative HTTP
 * tools. PK=customerId, SK=name, so a customer's tool names are unique by
 * schema and a listing is a single Query.
 *
 * Nothing here is secret — the credential *values* live KMS-encrypted in
 * CustomerToolCredentials and this table only stores the [CustomerTool.credentialRef]
 * pointing at them. Validation is the service's job; this class only stores
 * what it is given.
 */
class CustomerToolsRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun saveCustomerTool(customerId: String, tool: CustomerTool) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val item = mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                DynamoDBConstants.TOOL_NAME_KEY to AttributeValue.builder().s(tool.name).build(),
                DynamoDBConstants.TOOL_DESCRIPTION_KEY to AttributeValue.builder().s(tool.description).build(),
                DynamoDBConstants.TOOL_PARAMETERS_KEY to AttributeValue.builder().s(tool.parameters).build(),
                DynamoDBConstants.TOOL_PROVIDER_KEY to AttributeValue.builder().s(tool.provider).build(),
                DynamoDBConstants.TOOL_REQUEST_KEY to AttributeValue.builder().s(tool.request).build(),
                DynamoDBConstants.TOOL_CREDENTIAL_REF_KEY to AttributeValue.builder().s(tool.credentialRef).build(),
                DynamoDBConstants.TOOL_RESPONSE_TRANSFORM_KEY to
                    AttributeValue.builder().s(tool.responseTransform).build(),
                DynamoDBConstants.TOOL_STATUS_KEY to AttributeValue.builder().s(tool.status).build(),
                DynamoDBConstants.VERSION_KEY to AttributeValue.builder().n(tool.version.toString()).build(),
                DynamoDBConstants.TOOL_ORIGIN_KEY to AttributeValue.builder().s(tool.origin).build(),
                DynamoDBConstants.TOOL_ORIGIN_REF_KEY to AttributeValue.builder().s(tool.originRef).build(),
                DynamoDBConstants.TOOL_DISCOVERED_TOOLS_KEY to
                    AttributeValue.builder().s(tool.discoveredTools).build(),
                DynamoDBConstants.TOOL_LAST_DRY_RUN_AT_KEY to
                    AttributeValue.builder().s(tool.lastDryRunAt).build(),
                // createdAt is preserved by the caller across an overwrite; only
                // updatedAt is stamped here, so an upsert keeps its birth date.
                "createdAt" to AttributeValue.builder().s(tool.createdAt ?: now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build(),
            )
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(CUSTOMER_TOOLS_TABLE)
                    .item(item)
                    .build()
            )
            logger.info("Saved customer tool for $customerId / ${tool.name} (v${tool.version}, ${tool.status})")
        } catch (e: Exception) {
            logger.error("Failed to save customer tool for $customerId / ${tool.name}", e)
            throw e
        }
    }

    suspend fun getCustomerTool(customerId: String, name: String): CustomerTool? = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(CUSTOMER_TOOLS_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    DynamoDBConstants.TOOL_NAME_KEY to AttributeValue.builder().s(name).build(),
                ))
                .build()
        )
        response.item()?.takeIf { it.isNotEmpty() }?.let { itemToTool(it) }
    }

    suspend fun listCustomerTools(customerId: String): List<CustomerTool> = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.query(
            QueryRequest.builder()
                .tableName(CUSTOMER_TOOLS_TABLE)
                .keyConditionExpression("#cid = :cid")
                .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                .build()
        )
        response.items().mapNotNull { itemToTool(it) }
    }

    suspend fun deleteCustomerTool(customerId: String, name: String) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.deleteItem(
                DeleteItemRequest.builder()
                    .tableName(CUSTOMER_TOOLS_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        DynamoDBConstants.TOOL_NAME_KEY to AttributeValue.builder().s(name).build(),
                    ))
                    .build()
            )
            logger.info("Deleted customer tool for $customerId / $name")
        } catch (e: Exception) {
            logger.error("Failed to delete customer tool for $customerId / $name", e)
            throw e
        }
    }

    private fun itemToTool(item: Map<String, AttributeValue>): CustomerTool? {
        return CustomerTool(
            name = item[DynamoDBConstants.TOOL_NAME_KEY]?.s() ?: return null,
            description = item[DynamoDBConstants.TOOL_DESCRIPTION_KEY]?.s() ?: "",
            parameters = item[DynamoDBConstants.TOOL_PARAMETERS_KEY]?.s() ?: "{}",
            provider = item[DynamoDBConstants.TOOL_PROVIDER_KEY]?.s() ?: "http",
            request = item[DynamoDBConstants.TOOL_REQUEST_KEY]?.s() ?: "{}",
            credentialRef = item[DynamoDBConstants.TOOL_CREDENTIAL_REF_KEY]?.s() ?: "",
            responseTransform = item[DynamoDBConstants.TOOL_RESPONSE_TRANSFORM_KEY]?.s() ?: "{}",
            status = item[DynamoDBConstants.TOOL_STATUS_KEY]?.s() ?: "draft",
            version = item[DynamoDBConstants.VERSION_KEY]?.n()?.toIntOrNull() ?: 1,
            origin = item[DynamoDBConstants.TOOL_ORIGIN_KEY]?.s() ?: "manual",
            originRef = item[DynamoDBConstants.TOOL_ORIGIN_REF_KEY]?.s() ?: "",
            discoveredTools = item[DynamoDBConstants.TOOL_DISCOVERED_TOOLS_KEY]?.s() ?: "",
            lastDryRunAt = item[DynamoDBConstants.TOOL_LAST_DRY_RUN_AT_KEY]?.s() ?: "",
            createdAt = item["createdAt"]?.s(),
            updatedAt = item["updatedAt"]?.s(),
        )
    }
}
