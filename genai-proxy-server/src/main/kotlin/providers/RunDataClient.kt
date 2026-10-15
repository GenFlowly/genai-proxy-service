package com.genflowly.providers

import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mu.KLogger

/**
 * The purge's view of the retrieval-server's durable runs (plan 3.9). Like
 * RunsClient.cancelRun it calls the retrieval-server with plain HTTP over the
 * private Flycast address: the retrieval routes have no app-level auth, so
 * the proxy is the authorization point, and run ids only ever come from the
 * proxy's own rows (Message.runId, Conversation.pendingRuns), never from a
 * client.
 */
class RunDataClient(
    private val logger: KLogger,
    private val httpClient: HttpClient,
    private val retrievalServerUrl: String
) {
    enum class RunState { ACTIVE, TERMINAL, UNKNOWN }

    /**
     * GET /runs/{id}: TERMINAL for a finished run, UNKNOWN when the server
     * does not know it (404), ACTIVE otherwise. Throws when the state cannot
     * be read (transport error, 5xx, durable runs unavailable), so the
     * caller retries rather than mistaking a live run for a finished one.
     */
    suspend fun runState(runId: String): RunState {
        requireRunId(runId)
        val response = httpClient.get("$retrievalServerUrl/runs/$runId")
        if (response.status == HttpStatusCode.NotFound) return RunState.UNKNOWN
        check(response.status.isSuccess()) { "GET /runs returned ${response.status.value}" }
        val status = Json.parseToJsonElement(response.bodyAsText()).jsonObject["status"]?.jsonPrimitive?.content
        return if (status in TERMINAL_STATES) RunState.TERMINAL else RunState.ACTIVE
    }

    /**
     * DELETE /runs/{id}/data: the run's DBOS workflow rows (and children),
     * LangGraph checkpoints, run_events and tool ledger. Idempotent on the
     * server (a second call returns 204); a 404 also counts as deleted.
     * Throws on any other failure.
     */
    suspend fun deleteRunData(runId: String) {
        requireRunId(runId)
        val response = httpClient.delete("$retrievalServerUrl/runs/$runId/data")
        if (response.status.isSuccess() || response.status == HttpStatusCode.NotFound) return
        logger.warn { "DELETE /runs/$runId/data returned ${response.status.value}" }
        throw IllegalStateException("Run data deletion failed with ${response.status.value}")
    }

    /**
     * DELETE /customers/{id}/run-data: every durable run whose input is the
     * customer's, found on the retrieval-server by listing its workflows (so
     * runs no message row records are included), plus the customer's tool
     * ledger rows. Returns how many runs it deleted. Throws when a run may
     * still execute (409: the server cancelled it, retry once it ended) or on
     * any other failure, so the account job retries.
     */
    suspend fun deleteCustomerRunData(customerId: String): Int {
        require(CUSTOMER_ID.matches(customerId)) { "Refusing a malformed customer id" }
        val response = httpClient.delete("$retrievalServerUrl/customers/$customerId/run-data")
        val body = response.bodyAsText()
        val counts = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()
        if (response.status == HttpStatusCode.Conflict) {
            val active = counts?.get("active")?.jsonPrimitive?.content ?: "some"
            throw IllegalStateException("$active run(s) of the customer were still active and are cancelled; retry")
        }
        if (!response.status.isSuccess()) {
            logger.warn { "DELETE /customers/{id}/run-data returned ${response.status.value}" }
            throw IllegalStateException("Customer run data deletion failed with ${response.status.value}")
        }
        return counts?.get("deleted")?.jsonPrimitive?.content?.toIntOrNull() ?: 0
    }

    private fun requireRunId(runId: String) =
        require(RUN_ID.matches(runId)) { "Refusing a malformed run id" }

    companion object {
        /** DBOS workflow states after which a run never writes again (retrieval routes/runs.py). */
        val TERMINAL_STATES = setOf(
            "SUCCESS", "ERROR", "CANCELLED", "RETRIES_EXCEEDED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
        )
        private val RUN_ID = Regex("^[A-Za-z0-9_-]{1,128}$")
        private val CUSTOMER_ID = Regex("^[A-Za-z0-9-]{1,64}$")
    }
}
