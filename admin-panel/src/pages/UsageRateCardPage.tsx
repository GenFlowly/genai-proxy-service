import { useCallback, useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import {
    UsageRateCardCategory,
    UsageRateCardEntry,
    getUsageRateCard,
    putUsageRateCardEntry,
} from '../services/usageRateCardService'

// The rate keys this category's UsageSummaryService read path actually looks
// up (by dim3 — searchDepth; see genai-proxy-server's
// UsageSummaryService.getWebSearchUsage). Rows with no saved rate yet default
// to $0 here until an admin sets one.
//
// Vector DB deliberately has no rate card: Zilliz bills by data size/compute
// units on the customer's own cluster, not per operation call, so there's no
// per-unit USD figure that would mean anything — see
// UsageSummaryService.getVectorDbUsage, which returns raw op counts only.
const CATEGORY_RATE_KEYS: Record<UsageRateCardCategory, string[]> = {
    web_search: ['basic', 'advanced'],
}

const CATEGORY_LABELS: Record<UsageRateCardCategory, string> = {
    web_search: 'Web Search (USD per credit)',
}

/**
 * Admin rates for the Cost and Usage category with no real per-request
 * vendor price exposed to us — Web Search credits (Tavily). Customers never
 * see a real bill for these; the numbers here are read-time multipliers
 * UsageSummaryService applies to raw credit counts, producing an estimate
 * the UI labels "Estimated cost". Editing a rate re-prices every past date
 * range on its next read — this is acceptable for an estimate, but is a
 * real, immediate effect.
 */
export default function UsageRateCardPage() {
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [rates, setRates] = useState<Record<string, number>>({})
    const [savingKey, setSavingKey] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [messageKind, setMessageKind] = useState<'success' | 'error'>('success')

    const rateMapKey = (category: UsageRateCardCategory, rateKey: string) => `${category}#${rateKey}`

    const refresh = useCallback(async () => {
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            const response = await getUsageRateCard(token)
            const next: Record<string, number> = {}
            response.rates.forEach((entry: UsageRateCardEntry) => {
                next[rateMapKey(entry.category, entry.rateKey)] = entry.usdRate
            })
            setRates(next)
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Failed to load usage rate card')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const handleChange = (category: UsageRateCardCategory, rateKey: string, value: string) => {
        setMessage(null)
        const parsed = Number(value)
        setRates((prev) => ({ ...prev, [rateMapKey(category, rateKey)]: Number.isFinite(parsed) ? parsed : 0 }))
    }

    const handleSave = async (category: UsageRateCardCategory, rateKey: string) => {
        const key = rateMapKey(category, rateKey)
        setSavingKey(key)
        setMessage(null)
        try {
            const token = await getAccessTokenSilently()
            await putUsageRateCardEntry(token, { category, rateKey, usdRate: rates[key] ?? 0 })
            setMessageKind('success')
            setMessage(`Saved ${category} / ${rateKey}.`)
        } catch (e) {
            setMessageKind('error')
            setMessage(e instanceof Error ? e.message : 'Failed to save rate')
        } finally {
            setSavingKey(null)
        }
    }

    if (loading) return <div className="centered">Loading…</div>

    return (
        <section className="page">
            <h2>Cost and Usage Rate Card</h2>
            <p className="page-description">
                Per-unit USD rates for the Cost and Usage categories with no real vendor bill to read
                (Tavily search credits). These are estimates priced at read time — editing a rate changes
                what every past date range shows the next time a customer loads the page, not just new
                usage. Vector DB has no rate card here — Zilliz bills by data size and compute, not
                per operation, so its Cost and Usage page shows raw operation counts only.
            </p>

            {loadError && <div className="banner error">{loadError}</div>}
            {message && <div className={`banner ${messageKind}`}>{message}</div>}

            {(Object.keys(CATEGORY_RATE_KEYS) as UsageRateCardCategory[]).map((category) => (
                <div key={category} style={{ marginBottom: '2rem' }}>
                    <h3>{CATEGORY_LABELS[category]}</h3>
                    <div className="vendor-list">
                        {CATEGORY_RATE_KEYS[category].map((rateKey) => {
                            const key = rateMapKey(category, rateKey)
                            return (
                                <div
                                    key={key}
                                    className="vendor-card"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.75rem',
                                        padding: '0.6rem 0.9rem',
                                    }}
                                >
                                    <code style={{ minWidth: '6rem' }}>{rateKey}</code>
                                    <span style={{ opacity: 0.7 }}>$</span>
                                    <input
                                        type="number"
                                        step="0.0001"
                                        min="0"
                                        value={rates[key] ?? 0}
                                        onChange={(e) => handleChange(category, rateKey, e.target.value)}
                                        style={{ width: '8rem' }}
                                        data-testid={`usage-rate-${key}`}
                                    />
                                    <button
                                        className="primary"
                                        onClick={() => handleSave(category, rateKey)}
                                        disabled={savingKey === key}
                                    >
                                        {savingKey === key ? 'Saving…' : 'Save'}
                                    </button>
                                </div>
                            )
                        })}
                    </div>
                </div>
            ))}
        </section>
    )
}
