package repository

import org.slf4j.LoggerFactory
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest

class ApiKeyRepository(
    private val dynamoDbClient: DynamoDbClient = DynamoDbClient.builder().build(),
    private val tableName: String = "User"
) {
    private val logger = LoggerFactory.getLogger(ApiKeyRepository::class.java)

    fun saveApiKey(email: String, oidpProvider: String, apiKey: String) {
        val itemValues = mapOf(
            "email" to AttributeValue.builder().s(email).build(),
            "oidp_provider" to AttributeValue.builder().s(oidpProvider).build(),
            "api_key" to AttributeValue.builder().s(apiKey).build()
        )

        val putRequest = PutItemRequest.builder()
            .tableName(tableName)
            .item(itemValues)
            .build()

        logger.info("Saving API key for email={}, provider={} to table={}", email, oidpProvider, tableName)
        dynamoDbClient.putItem(putRequest)
    }
}
