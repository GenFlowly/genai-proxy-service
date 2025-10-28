package com.genflowly.utils

import com.genflowly.aicallerlib.models.AIVendor
import service.CustomerProfileService

suspend fun fetchApiKey(
    aiVendor: AIVendor,
    customerId: String,
    customerProfileService: CustomerProfileService
): String {
    return customerProfileService.getCustomerApiKeyForVendor(
        aiVendor,
        customerId
    )
}