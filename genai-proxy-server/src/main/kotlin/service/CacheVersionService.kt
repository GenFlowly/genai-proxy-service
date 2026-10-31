package com.genflowly.service

import com.genflowly.models.api.CacheVersions
import com.genflowly.repository.CacheVersionRepository
import com.genflowly.repository.CacheVersionRepository.Resource
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Cache-version counters the web app uses to skip refetching unchanged
 * per-customer resources (see /onboard's cacheVersions field). Customer-owned
 * and SYSTEM-owned writes bump separate counters; the served version is their
 * sum, so a SYSTEM-side change (admin publish, seeder) invalidates every
 * customer's cache without touching customer rows.
 *
 * Bumps are deliberately non-fatal: the mutation they ride on must not fail
 * because a counter write failed. The error log is the tripwire — a silently
 * missed bump means clients serve stale data until the next successful one.
 */
class CacheVersionService(private val cacheVersionRepository: CacheVersionRepository) {

    suspend fun bumpCustomer(customerId: String, resource: Resource) = safeBump(customerId, resource)

    suspend fun bumpSystem(resource: Resource) =
        safeBump(CacheVersionRepository.SYSTEM_VERSIONS_ITEM_ID, resource)

    /**
     * Null when either read fails: a failed read must not serve zeros, which
     * would be indistinguishable from a genuinely-new customer's counters and
     * could wrongly match a client's cached version. Null tells the client
     * "no version gating this session — refetch as before".
     */
    suspend fun getCacheVersions(customerId: String): CacheVersions? = coroutineScope {
        val customer = async { safeGetVersions(customerId) }
        val system = async { safeGetVersions(CacheVersionRepository.SYSTEM_VERSIONS_ITEM_ID) }
        val c = customer.await() ?: return@coroutineScope null
        val s = system.await() ?: return@coroutineScope null
        CacheVersions(
            agents = (c[Resource.AGENTS] ?: 0) + (s[Resource.AGENTS] ?: 0),
            requestAgents = (c[Resource.REQUEST_AGENTS] ?: 0) + (s[Resource.REQUEST_AGENTS] ?: 0),
            projects = (c[Resource.PROJECTS] ?: 0),
        )
    }

    private suspend fun safeBump(ownerId: String, resource: Resource) {
        try {
            cacheVersionRepository.bump(ownerId, resource)
        } catch (e: Exception) {
            logger.error(e) { "Cache-version bump failed for owner=$ownerId resource=$resource — clients may serve stale $resource until the next successful bump" }
        }
    }

    private suspend fun safeGetVersions(ownerId: String): Map<Resource, Long>? {
        return try {
            cacheVersionRepository.getVersions(ownerId)
        } catch (e: Exception) {
            logger.warn(e) { "Cache-version read failed for owner=$ownerId — version gating disabled for this response" }
            null
        }
    }
}
