package com.genflowly.providers

import com.genflowly.DynamoDBConstants.AI_VENDOR_KEY
import com.genflowly.DynamoDBConstants.CLIENT_SORT_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_API_KEY_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_PREFERENCES_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_PROFILE_TABLE
import com.genflowly.DynamoDBConstants.INSTRUCTION_CONTENT_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_CREATOR_GSI_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_CREATOR_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_ID_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_VERSIONS_LIST_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_NAME_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_TABLE
import com.genflowly.DynamoDBConstants.INSTRUCTION_VERSION_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_ID_SORT_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_TABLE
import com.genflowly.DynamoDBConstants.SUB_PARTITION_KEY
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.models.api.AIMode
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import models.AIConfig
import models.Conversation
import models.Message
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest

class DynamoDBProvider(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {
//    suspend fun getConversation(conversationId: String, customerId: String): Conversation? =
//        withContext(Dispatchers.IO) {
//            try {
//                val key = mapOf(
//                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build(),
//                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
//                )
//
//                val request = GetItemRequest.builder()
//                    .tableName(CONVERSATION_TABLE)
//                    .key(key)
//                    .build()
//
//                val response = dynamoDbClient.getItem(request)
//                val item = response.item() ?: return@withContext null
//
//                val client = item["client"]?.s() ?: return@withContext null
//
//                Conversation(
//                    conversationId = conversationId,
//                    customerId = customerId,
//                    client = client
//                )
//            } catch (e: Exception) {
//                logger.error("Failed to Get Conversation from DynamoDB", e)
//                throw e
//            }
//        }




    suspend fun getCustomerApiKey(aiVendor: String, customerId: String): String? =
        withContext(Dispatchers.IO) {
        val key = mapOf(
            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId)
                .build(),
            AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()
        )

        val request =
            GetItemRequest.builder().tableName(CUSTOMER_API_KEY_TABLE).key(key)
                .build()

        val response = dynamoDbClient.getItem(request)
            return@withContext response.item()?.get("apiKey")?.s()
    }


    suspend fun createConversation(
        conversation: Conversation
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder()
                    .s(conversation.customerId).build(),
                CONVERSATION_ID_KEY to AttributeValue.builder().s
                    (conversation.conversationId)
                    .build(),
                "client" to AttributeValue.builder().s(conversation.client).build(),
            ))

            val putReq = PutItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Created Conversation for ${conversation
                .customerId} to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to Create Conversation in DynamoDB", e)
            throw e
        }
    }

    suspend fun getMessage(
        conversationId: String,
        messageId: String
    ): Message? = withContext(Dispatchers.IO) {

        val key = mapOf(
            "conversationId" to AttributeValue.builder().s(conversationId).build(),
            "messageId" to AttributeValue.builder().s(messageId).build()
        )

        val request = GetItemRequest.builder()
            .tableName(MESSAGE_TABLE)
            .key(key)
            .build()

        val response = dynamoDbClient.getItem(request)
        val item = response.item() ?: return@withContext null
        return@withContext itemToMessage(item)
    }

    suspend fun getMessagesForConversation(
        conversationId: String
    ): List<Message> = withContext(Dispatchers.IO) {
        val request = software.amazon.awssdk.services.dynamodb.model.QueryRequest.builder()
            .tableName(MESSAGE_TABLE)
            .keyConditionExpression("conversationId = :cid")
            .expressionAttributeValues(mapOf(
                ":cid" to AttributeValue.builder().s(conversationId).build()
            ))
            .build()

        val response = dynamoDbClient.query(request)
        response.items().mapNotNull { itemToMessage(it) }
    }

    private fun itemToMessage(item: Map<String, AttributeValue>): Message? {
        val text = item["text"]?.s() ?: return null
        val sequenceStr = item["sequence"]?.n() ?: return null
        val client = item["client"]?.s() ?: return null
        val role = item["role"]?.s() ?: return null
        val customerId = item["customerId"]?.s() ?: return null
        val systemPrompt = item["systemPrompt"]?.s() ?: return null

        val previousMessageId = item["previousMessageId"]?.s()

        val sequence = sequenceStr.toIntOrNull() ?: return null

        val aiConfigAttr = item["aiConfig"] ?: return null
        val aiConfig = attributeValueToAiConfig(aiConfigAttr)

        return Message(
            messageId = item["messageId"]?.s() ?: return null,
            conversationId = item["conversationId"]?.s() ?: return null,
            text = text,
            client = client,
            role = role,
            customerId = customerId,
            sequence = sequence,
            systemPrompt = systemPrompt,
            aiConfig = aiConfig,
            previousMessageId = previousMessageId
        )
    }

    private fun attributeValueToAiConfig(
        attributeValue: AttributeValue
    ): List<AIConfig> =
        attributeValue.l().map { av ->
            val map = av.m()
            AIConfig(
                aiVendor = AIVendor.valueOf(map["aiVendor"]!!.s()),
                model = map["model"]!!.s()
            )
        }


    suspend fun createMessage(
        message: Message
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(
                mutableMapOf(
                    CONVERSATION_ID_KEY to AttributeValue.builder()
                        .s(message.conversationId)
                        .build(),

                    MESSAGE_ID_SORT_KEY to AttributeValue.builder()
                        .s(message.messageId)
                        .build(),

                    CUSTOMER_ID_KEY to AttributeValue.builder()
                        .s(message.customerId)
                        .build(),

                    "sequence" to AttributeValue.builder()
                        .n(message.sequence?.toString() ?: "0")
                        .build(),

                    "client" to AttributeValue.builder()
                        .s(message.client)
                        .build(),

                    "aiConfig" to aiConfigToAttributeValue(message.aiConfig),

                    "role" to AttributeValue.builder()
                        .s(message.role)
                        .build(),

                    "text" to AttributeValue.builder()
                        .s(message.text)
                        .build(),

                    "systemPrompt" to AttributeValue.builder()
                        .s(message.systemPrompt)
                        .build(),

                    "previousMessageId" to AttributeValue.builder()
                        .s(message.previousMessageId ?: "")
                        .build()
                )
            )

            val putReq = PutItemRequest.builder()
                .tableName(MESSAGE_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)

            logger.info(
                "Saved message for conversation {} to DynamoDB",
                message.conversationId
            )
        } catch (e: Exception) {
            logger.error("Failed to create Message in DynamoDB", e)
            throw e
        }
    }

    private fun aiConfigToAttributeValue(
        aiConfig: List<AIConfig>
    ): AttributeValue =
        AttributeValue.builder()
            .l(
                aiConfig.map { config ->
                    AttributeValue.builder()
                        .m(
                            mapOf(
                                "aiVendor" to AttributeValue.builder()
                                    .s(config.aiVendor.name)
                                    .build(),
                                "model" to AttributeValue.builder()
                                    .s(config.model)
                                    .build()
                            )
                        )
                        .build()
                }
            )
            .build()

    suspend fun savePreferences(
        customerId: String,
        preferredModels: List<AIConfig>?,
        preferredGenerativeMode: AIMode?,
        otherPreferences: Map<String, String>?
    ) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val updateParts = mutableListOf<String>()
            val attrNames = mutableMapOf<String, String>()
            val attrValues = mutableMapOf<String, AttributeValue>()

            // Always update updatedAt
            updateParts.add("#updatedAt = :updatedAt")
            attrNames["#updatedAt"] = "updatedAt"
            attrValues[":updatedAt"] = AttributeValue.builder().s(now).build()

            // set createdAt if not exists
            updateParts.add("#createdAt = if_not_exists(#createdAt, :createdAt)")
            attrNames["#createdAt"] = "createdAt"
            attrValues[":createdAt"] = AttributeValue.builder().s(now).build()

            if (preferredGenerativeMode != null) {
                updateParts.add("#preferredGenerativeMode = :preferredGenerativeMode")
                attrNames["#preferredGenerativeMode"] = "preferredGenerativeMode"
                attrValues[":preferredGenerativeMode"] = AttributeValue.builder().s(preferredGenerativeMode.name).build()
            }

            if (preferredModels != null) {
                updateParts.add("#preferredModels = :preferredModels")
                attrNames["#preferredModels"] = "preferredModels"
                attrValues[":preferredModels"] = aiConfigToAttributeValue(preferredModels)
            }

            if (!otherPreferences.isNullOrEmpty()) {
                updateParts.add("#otherPreferences = :otherPreferences")
                attrNames["#otherPreferences"] = "otherPreferences"
                attrValues[":otherPreferences"] = AttributeValue.builder().m(
                    otherPreferences.mapValues { AttributeValue.builder().s(it.value).build() }
                ).build()
            }

            val updateReq = software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest.builder()
                .tableName(CUSTOMER_PREFERENCES_TABLE)
                .key(mapOf(CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()))
                .updateExpression("SET " + updateParts.joinToString(", "))
                .expressionAttributeNames(attrNames)
                .expressionAttributeValues(attrValues)
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Saved preferences for customer $customerId to DynamoDB (Upsert)")
        } catch (e: Exception) {
            logger.error("Failed to save Customer Preferences to DynamoDB", e)
            throw e
        }
    }

    suspend fun saveCustomerApiKey(
        customerId: String,
        aiVendor: String,
        encryptedKey: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder()
                    .s(customerId).build(),
                AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor)
                    .build(),
                "apiKey" to AttributeValue.builder().s(encryptedKey).build(),
                "isAPIKeyValid" to AttributeValue.builder().bool(true).build()
            ))

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

    suspend fun initCustomerApiKey(
        customerId: String,
        aiVendor: String
    ) = withContext(Dispatchers.IO) {
        try {
            // Initial state: Valid = false, no apiKey
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build(),
                "isAPIKeyValid" to AttributeValue.builder().bool(false).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Initialized API key status for $customerId vendor $aiVendor")
        } catch (e: Exception) {
            logger.error("Failed to init API key status", e)
            // Non-blocking error for onboarding? Or should we throw?
            // Logging is safer for now.
        }
    }

    suspend fun onboardCustomer(
        sub: String,
        client: String,
        customerId: String,
        email: String?,
        name: String?,
        picture: String?
    ) = withContext(Dispatchers.IO) {
        val baseItem = buildMap {
            put(SUB_PARTITION_KEY, AttributeValue.builder().s(sub).build())
            put(CLIENT_SORT_KEY, AttributeValue.builder().s(client).build())
            put("customerId", AttributeValue.builder().s(customerId).build())

            email?.let { put("email", AttributeValue.builder().s(it).build()) }
            name?.let { put("name", AttributeValue.builder().s(it).build()) }
            picture?.let { put("picture", AttributeValue.builder().s(it).build()) }
        }

        val item = withTimestamps(baseItem)

        val putReq = PutItemRequest.builder()
            .tableName(CUSTOMER_PROFILE_TABLE)
            .item(item)
            .build()

        dynamoDbClient.putItem(putReq)
        logger.info { "Onboarded user $sub in DynamoDB with customerId: $customerId" }
    }

    suspend fun getCustomerProfile(sub: String, client: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val key = mapOf(
                SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
            )

            val request = GetItemRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .key(key)
                .build()

            val response = dynamoDbClient.getItem(request)
            return@withContext if (response.hasItem()) response.item() else null
        }

    /**
     * Query customer profile by sub only (partition key)
     * Returns the first matching profile if multiple clients exist for the same sub
     */
    suspend fun queryCustomerProfileBySub(sub: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val request = QueryRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .keyConditionExpression("#sub = :sub")
                .expressionAttributeNames(
                    mapOf("#sub" to SUB_PARTITION_KEY)
                )
                .expressionAttributeValues(
                    mapOf(":sub" to AttributeValue.builder().s(sub).build())
                )
                .limit(1)  // Only need the first result
                .build()

            val response = dynamoDbClient.query(request)
            return@withContext response.items().firstOrNull()
        }


    private fun withTimestamps(base: Map<String, AttributeValue>): Map<String, AttributeValue> {
        val now = Instant.now().toString()
        return base + mapOf(
            "createdAt" to AttributeValue.builder().s(now).build(),
            "updatedAt" to AttributeValue.builder().s(now).build()
        )
    }


    suspend fun getAIConfigPreferences(customerId: String): AIConfigPreferences? =
        withContext(Dispatchers.IO) {
            val key = mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
            )

            val request = GetItemRequest.builder()
                .tableName(CUSTOMER_PREFERENCES_TABLE)
                .key(key)
                .build()

            val response = dynamoDbClient.getItem(request)
            val item = response.item() ?: return@withContext null

            // Parse result
            // Note: attributes are stored as 'preferredModels', 'preferredGenerativeMode' etc.
            // We need to map them back to AIConfigPreferences object
            
            val modelsAttr = item["preferredModels"]
            val preferredModels = modelsAttr?.let { attributeValueToAiConfig(it) }
            
            val modeAttr = item["preferredGenerativeMode"]?.s()
            val preferredGenerativeMode = modeAttr?.let { AIMode.valueOf(it) }

            AIConfigPreferences(
                preferredModels = preferredModels,
                preferredGenerativeMode = preferredGenerativeMode
            )
        }

    suspend fun getCustomerApiKeys(customerId: String): List<models.AIVendorAPIKeyStatus> =
        withContext(Dispatchers.IO) {
            val request = software.amazon.awssdk.services.dynamodb.model.QueryRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .keyConditionExpression("#cid = :cid")
                .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                .build()

            val response = dynamoDbClient.query(request)
            
            response.items().mapNotNull { item ->
                val vendorStr = item[AI_VENDOR_KEY]?.s() ?: return@mapNotNull null
                val aiVendor = try {
                    AIVendor.valueOf(vendorStr)
                } catch (e: Exception) {
                    return@mapNotNull null
                }
                
                // Check explicitly stored validation status or fallback to apiKey presence
                val isValid = item["isAPIKeyValid"]?.bool() ?: (item["apiKey"]?.s() != null)

                models.AIVendorAPIKeyStatus(
                    aiVendor = aiVendor,
                    isAPIKeyValid = isValid
                )
            }
        }
        
    suspend fun getInstructionById(id: String): models.Instruction? =
        withContext(Dispatchers.IO) {
            val request = GetItemRequest.builder()
                .tableName(INSTRUCTION_TABLE)
                .key(mapOf(INSTRUCTION_ID_KEY to AttributeValue.builder().s(id).build()))
                .build()

            val response = dynamoDbClient.getItem(request)
            val item = response.item() ?: return@withContext null
            itemToInstruction(item)
        }

    suspend fun saveInstruction(instruction: models.Instruction) = withContext(Dispatchers.IO) {
        try {
            val versionsAttribute = AttributeValue.builder().l(
                instruction.instructionVersionList.map { v ->
                    AttributeValue.builder().m(
                        mapOf(
                            "instructions" to AttributeValue.builder().s(v.instructions).build(),
                            "version" to AttributeValue.builder().n(v.version.toString()).build()
                        )
                    ).build()
                }
            ).build()

            val item = withTimestamps(mapOf(
                INSTRUCTION_ID_KEY to AttributeValue.builder().s(instruction.id).build(),
                INSTRUCTION_CREATOR_KEY to AttributeValue.builder().s(instruction.creator).build(),
                INSTRUCTION_NAME_KEY to AttributeValue.builder().s(instruction.name).build(),
                INSTRUCTION_VERSIONS_LIST_KEY to versionsAttribute
            ))

            val putReq = PutItemRequest.builder()
                .tableName(INSTRUCTION_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved instruction ${instruction.id} with ${instruction.instructionVersionList.size} versions for ${instruction.creator}")
        } catch (e: Exception) {
            logger.error("Failed to save instruction", e)
            throw e
        }
    }
    suspend fun getInstructionsByCreator(creatorId: String): List<models.Instruction> =
        withContext(Dispatchers.IO) {
            val request = QueryRequest.builder()
                .tableName(INSTRUCTION_TABLE)
                .indexName(INSTRUCTION_CREATOR_GSI_KEY)
                .keyConditionExpression("$INSTRUCTION_CREATOR_KEY = :creator")
                .expressionAttributeValues(
                    mapOf(":creator" to AttributeValue.builder().s(creatorId).build())
                )
                .build()

            val response = dynamoDbClient.query(request)
            response.items().mapNotNull { itemToInstruction(it) }
        }

    private fun itemToInstruction(item: Map<String, AttributeValue>): models.Instruction? {
        val versionsList = item[INSTRUCTION_VERSIONS_LIST_KEY]?.l()?.mapNotNull { av ->
            val m = av.m()
            val instr = m["instructions"]?.s() ?: return@mapNotNull null
            val ver = m["version"]?.n()?.toInt() ?: 1
            models.InstructionVersion(instr, ver)
        } ?: emptyList()

        return models.Instruction(
            id = item[INSTRUCTION_ID_KEY]?.s() ?: return null,
            creator = item[INSTRUCTION_CREATOR_KEY]?.s() ?: return null,
            name = item[INSTRUCTION_NAME_KEY]?.s() ?: "",
            instructionVersionList = versionsList
        )
    }
}