package com.genflowly.providers

import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest

class DynamoDBProvider {

    private val dynamoDb = DynamoDbClient.builder().build()

    private val tableName = "User"

    fun getApiKey(provider: String): String? {
        val key = mapOf(
            "email" to AttributeValue.builder().s("test@test.com").build(),
            "oidp_provider" to AttributeValue.builder().s(provider).build()
        )

        val request =
            GetItemRequest.builder().tableName(tableName).key(key).build()

        val response = dynamoDb.getItem(request)
        return response.item()?.get("api_key")?.s()
    }

}