package com.genflowly.providers

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest

class DynamoDBProvider(
    private val ddbClient: DynamoDbClient,
    private val logger: KLogger
) {

    private val tableName = "User"

    fun getApiKey(provider: String): String? {
        val key = mapOf(
            "email" to AttributeValue.builder().s("test@test.com").build(),
            "oidp_provider" to AttributeValue.builder().s(provider).build()
        )

        val request =
            GetItemRequest.builder().tableName(tableName).key(key).build()

        val response = ddbClient.getItem(request)
        return response.item()?.get("api_key")?.s()
    }


    suspend fun saveApiKey(email: String, provider: String, encryptedKey: String) = withContext(
        Dispatchers.IO) {
        try {
            val item = mapOf(
                "email" to AttributeValue.builder().s(email).build(),
                "provider" to AttributeValue.builder().s(provider).build(),
                "api_key" to AttributeValue.builder().s(encryptedKey).build()
            )

            val putReq = PutItemRequest.builder()
                .tableName(tableName)
                .item(item)
                .build()

            ddbClient.putItem(putReq)
            logger.info("Saved API key for $email to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save API key to DynamoDB", e)
            throw e
        }
    }

}