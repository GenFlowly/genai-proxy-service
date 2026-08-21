package com.genflowly.service

import com.genflowly.models.ShareRole
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.ShareRepository

/**
 * Resolves share rows into user-facing profile lists: synthesizes the PUBLIC
 * pseudo-profile, joins real shares to customer profiles, and propagates each
 * share's role. Shared by the conversation and instruction domains — this is
 * the policy that used to live inside the DynamoDB layer.
 */
class SharedUsersResolver(
    private val shareRepository: ShareRepository,
    private val customerProfileRepository: CustomerProfileRepository
) {

    suspend fun getUsersWithSharedEntity(entityId: String): List<com.genflowly.models.CustomerProfile> =
        resolve(shareRepository.getSharesForEntity(entityId))

    suspend fun getUsersWithSharedConversation(conversationId: String): List<com.genflowly.models.CustomerProfile> =
        resolve(shareRepository.getSharesForConversation(conversationId))

    private suspend fun resolve(shares: List<Pair<String, ShareRole>>): List<com.genflowly.models.CustomerProfile> =
        shares.mapNotNull { (customerId, role) ->
            if (customerId == "PUBLIC") {
                return@mapNotNull com.genflowly.models.CustomerProfile(
                    customerId = "PUBLIC",
                    sub = "",
                    client = "",
                    email = null,
                    name = "Public",
                    picture = null,
                    username = "Public",
                    isDiscoverable = true,
                    role = role
                )
            }

            val profileItem = customerProfileRepository.getCustomerProfileByCustomerId(customerId)
            if (profileItem != null) {
                com.genflowly.models.CustomerProfile(
                    customerId = customerId,
                    sub = profileItem["sub"]?.s() ?: "",
                    client = profileItem["client"]?.s() ?: "",
                    email = profileItem["email"]?.s(),
                    name = profileItem["name"]?.s(),
                    picture = profileItem["picture"]?.s(),
                    username = profileItem["username"]?.s(),
                    isDiscoverable = profileItem["isDiscoverable"]?.bool() ?: false,
                    role = role
                )
            } else null
        }
}
