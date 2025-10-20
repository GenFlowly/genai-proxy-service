package com.genflowly.providers

import com.genflowly.DynamoDBConstants.AI_VENDOR_SORT_KEY
import com.genflowly.DynamoDBConstants.CLIENT_SORT_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_API_KEY_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_PARTITION_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_PROFILE_TABLE
import com.genflowly.DynamoDBConstants.SUB_PARTITION_KEY
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest

class DynamoDBProvider(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    fun getCustomerApiKey(aiVendor: String, customerId: String): String? {
        val key = mapOf(
            CUSTOMER_ID_PARTITION_KEY to AttributeValue.builder().s(customerId).build(),
            AI_VENDOR_SORT_KEY to AttributeValue.builder().s(aiVendor).build()
        )

        val request =
            GetItemRequest.builder().tableName(CUSTOMER_API_KEY_TABLE).key(key)
                .build()

        val response = dynamoDbClient.getItem(request)
        return response.item()?.get("apiKey")?.s()
    }

    suspend fun saveCustomerApiKey(
        customerId: String,
        aiVendor: String,
        encryptedKey: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = mapOf(
                CUSTOMER_ID_PARTITION_KEY to AttributeValue.builder().s(customerId).build(),
                AI_VENDOR_SORT_KEY to AttributeValue.builder().s(aiVendor).build(),
                "apiKey" to AttributeValue.builder().s(encryptedKey).build()
            )

            val putReq = PutItemRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved API key for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save API key to DynamoDB", e)
            throw e
        }
    }

    suspend fun onboardCustomer(
        sub: String,
        client: String,
        customerId: String,
        email: String?,
        name: String?) =
        withContext(Dispatchers.IO) {
            val item = mapOf(
                SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                CLIENT_SORT_KEY to AttributeValue.builder().s(client).build(),
                "customerId" to AttributeValue.builder().s(customerId).build(),
                "email" to AttributeValue.builder().s(email).build(),
                "name" to AttributeValue.builder().s(name).build(),
            )

            val putReq = PutItemRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info { "Onboarded user $sub in DynamoDB" }
        }

}