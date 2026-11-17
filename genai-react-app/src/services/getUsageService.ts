import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'

// Mirrors genai-proxy-server models/api/UsageModels.kt
//
// This is the aggregate-fetch service for the Cost and Usage settings pages
// ({from, to} -> a summary). Kept separate from getAIUsageService.ts, which
// fetches the exact cost of one already-sent message, not an aggregate.

/** One breakdown row — grouped by vendor (model is '') or by vendor+model. */
export interface UsageByDim {
    vendor: string
    model?: string
    costUsd: number
    totalTokens?: number | null
    inputTokens?: number | null
    outputTokens?: number | null
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
    requestCount: number
}

/** One UTC day's totals; days with no usage are left out. */
export interface UsageByDay {
    date: string
    costUsd: number
    requestCount: number
}

export interface LlmUsageSummary {
    totalCostUsd: number
    byVendor: UsageByDim[]
    byModel: UsageByDim[]
    /** Absent from servers older than the per-day series. */
    byDay?: UsageByDay[]
}

export interface EmbeddingUsageSummary {
    totalCostUsd: number
    byVendor: UsageByDim[]
    byModel: UsageByDim[]
    byDay?: UsageByDay[]
}

/** One estimate-breakdown row: opType (vector DB) or searchDepth (web search). */
export interface EstimatedUsageBreakdownRow {
    key: string
    count: number
    costUsd: number
}

/**
 * Web Search totals: priced at read time from an admin rate card against raw
 * credit counts — never a real vendor bill. `isEstimate` is always true; the
 * UI must keep that visible.
 */
export interface EstimatedUsageSummary {
    totalCostUsd: number
    isEstimate: boolean
    breakdown: EstimatedUsageBreakdownRow[]
}

/** One operation-type row: raw count only, no dollar figure. */
export interface VectorDbUsageBreakdownRow {
    opType: string
    count: number
}

/**
 * Vector DB totals: Zilliz bills by data size/compute units, not per
 * operation call, so a count can never be converted into a meaningful dollar
 * estimate — no cost field at all, only raw operation-volume counts.
 */
export interface VectorDbUsageSummary {
    breakdown: VectorDbUsageBreakdownRow[]
}

export interface UsageDateRange {
    from: string
    to: string
}

/**
 * GET helper shared by every usage endpoint. A 404 means the category's
 * instrumentation hasn't shipped yet (Vector DB/Web Search routes are
 * reserved but not registered until their phase lands) — callers get `null`
 * for that, not an error, so pages can render a graceful "not tracked yet"
 * state instead of an error toast. Any other non-OK status is a real failure
 * and throws.
 */
async function fetchUsageOrNotLive<T>(url: string, token: string): Promise<T | null> {
    const response = await fetchWithRetry(url, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (response.status === 404) {
        return null
    }

    if (!response.ok) {
        throw new Error(`Get usage failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as T
}

/** Per-customer LLM cost/usage summary for a date range. Live. */
export async function getLlmUsage(token: string, range: UsageDateRange): Promise<LlmUsageSummary> {
    const result = await fetchUsageOrNotLive<LlmUsageSummary>(
        endpoints.usageLlm(range.from, range.to),
        token
    )
    if (result === null) {
        // Not expected in practice (this endpoint is live) — surface it as a
        // real error rather than silently rendering an empty page.
        throw new Error('Get LLM usage failed: unexpected 404')
    }
    return result
}

/** Per-customer embedding cost/usage summary for a date range. Live. */
export async function getEmbeddingUsage(
    token: string,
    range: UsageDateRange
): Promise<EmbeddingUsageSummary | null> {
    return fetchUsageOrNotLive<EmbeddingUsageSummary>(endpoints.usageEmbedding(range.from, range.to), token)
}

/** Per-customer vector DB operation counts for a date range. `null` until that phase ships. */
export async function getVectorDbUsage(
    token: string,
    range: UsageDateRange
): Promise<VectorDbUsageSummary | null> {
    return fetchUsageOrNotLive<VectorDbUsageSummary>(endpoints.usageVectorDb(range.from, range.to), token)
}

/** Per-customer estimated web search usage for a date range. `null` until that phase ships. */
export async function getWebSearchUsage(
    token: string,
    range: UsageDateRange
): Promise<EstimatedUsageSummary | null> {
    return fetchUsageOrNotLive<EstimatedUsageSummary>(endpoints.usageWebSearch(range.from, range.to), token)
}
