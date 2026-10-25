import { endpoints } from '../config/endpoints'

/** The two Cost and Usage categories priced at READ time (vs. LLM/Embedding,
 * priced from AIModelCatalog at write time) — see UsageRollupRepository. */
export type UsageRateCardCategory = 'vector_db' | 'web_search'

export interface UsageRateCardEntry {
    category: UsageRateCardCategory
    rateKey: string
    usdRate: number
}

export interface GetUsageRateCardResponse {
    rates: UsageRateCardEntry[]
}

async function assertOk(response: Response, action: string): Promise<void> {
    if (response.ok) return
    if (response.status === 403) {
        throw new Error('Admin access required — your account is not on the admin allowlist.')
    }
    if (response.status === 400) {
        const reason = await response
            .json()
            .then((body) => body?.error as string | undefined)
            .catch(() => undefined)
        if (reason) throw new Error(reason)
    }
    throw new Error(`${action} failed: ${response.status} ${response.statusText}`)
}

export async function getUsageRateCard(token: string): Promise<GetUsageRateCardResponse> {
    const response = await fetch(endpoints.usageRateCard, {
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, 'Loading usage rate card')
    return response.json()
}

export async function putUsageRateCardEntry(token: string, entry: UsageRateCardEntry): Promise<void> {
    const response = await fetch(endpoints.usageRateCard, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(entry),
    })
    await assertOk(response, 'Saving usage rate card entry')
}
