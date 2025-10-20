package com.genflowly

object DynamoDBConstants {
    const val CUSTOMER_PROFILE_TABLE = "CustomerProfile"
    const val SUB_PARTITION_KEY = "sub"
    const val CLIENT_SORT_KEY = "client"

    const val CUSTOMER_USAGE_TABLE = "CustomerAIUsage"

    const val CUSTOMER_API_KEY_TABLE = "CustomerVendorApiKeys"
    const val CUSTOMER_ID_PARTITION_KEY = "customerId"
    const val AI_VENDOR_SORT_KEY = "customerId"
}