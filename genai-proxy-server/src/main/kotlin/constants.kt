package com.genflowly

object DynamoDBConstants {
    const val CUSTOMER_PROFILE_TABLE = "CustomerProfile"
    const val SUB_PARTITION_KEY = "sub"
    const val CLIENT_SORT_KEY = "client"

    const val CUSTOMER_USAGE_TABLE = "CustomerAIUsage"
    const val USAGE_DATE_SORT_KEY = "usageDate"

    const val CUSTOMER_API_KEY_TABLE = "CustomerVendorApiKeys"
    const val CUSTOMER_ID_KEY = "customerId"
    const val AI_VENDOR_KEY = "aiVendor"

    const val CONVERSATION_TABLE = "Conversation"
    const val CONVERSATION_ID_KEY = "conversationId"

    const val MESSAGE_TABLE = "Message"
    const val MESSAGE_ID_SORT_KEY = "messageId"

    const val CUSTOMER_PREFERENCES_TABLE = "CustomerPreferences"

    const val INSTRUCTION_TABLE = "Instructions"
    const val INSTRUCTION_ID_KEY = "instructionId"
    const val INSTRUCTION_CREATOR_KEY = "creator"
    const val INSTRUCTION_NAME_KEY = "name"
    const val INSTRUCTION_CONTENT_KEY = "instructions"
    const val INSTRUCTION_VERSION_KEY = "version"
    const val INSTRUCTION_CREATOR_GSI_KEY = "creatorIndex"
    const val INSTRUCTION_CREATOR_GSI_KEY = "creatorIndex"

}