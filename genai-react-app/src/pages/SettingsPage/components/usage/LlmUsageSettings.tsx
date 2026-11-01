import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateRangePicker, DateRange } from '@genflowly/component-library'
import { useAuth } from '../../../../context/AuthContext'
import { getLlmUsage, LlmUsageSummary, UsageByDim } from '../../../../services/getUsageService'
import { defaultUsageRange, usageDateRangePresets } from './usageDateRange'
import { formatUsd, formatCount } from './usageFormat'
import styles from './LlmUsageSettings.module.scss'

/**
 * Cost and Usage > LLM Models — the one category with instrumentation live
 * today (CostCalculationService's per-message costUsd fans into the
 * CustomerAIUsage rollup on every createMessage; see UsageSummaryService.kt
 * on the backend). The other three Cost and Usage pages are placeholders
 * until their own phases land.
 */
export function LlmUsageSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    const [range, setRange] = useState<DateRange>(defaultUsageRange)
    const [summary, setSummary] = useState<LlmUsageSummary | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(false)

    const load = useCallback(async (nextRange: DateRange) => {
        if (!isAuthenticated) return
        setLoading(true)
        setError(false)
        try {
            const token = await getAccessTokenSilently()
            const result = await getLlmUsage(token, nextRange)
            setSummary(result)
        } catch (err) {
            console.error('LlmUsageSettings: failed to fetch usage', err)
            setError(true)
        } finally {
            setLoading(false)
        }
    }, [isAuthenticated, getAccessTokenSilently])

    useEffect(() => {
        void load(range)
        // `load` changes identity only when auth state does; `range` is the
        // actual trigger for a refetch and is already in the dependency array.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [range, load])

    const handleRangeChange = (next: DateRange) => setRange(next)

    const totalRequests = summary?.byVendor.reduce((sum, row) => sum + row.requestCount, 0) ?? 0
    const hasRows = !!summary && summary.byVendor.length > 0

    const renderRows = (rows: UsageByDim[], showModel: boolean) => (
        <div className={styles.tableScroll}>
            <table className={styles.table}>
                <thead>
                    <tr>
                        <th>{t('settingsPage.usageCommon.vendor')}</th>
                        {showModel && <th>{t('settingsPage.usageCommon.model')}</th>}
                        <th className={styles.numeric}>{t('settingsPage.usageCommon.totalCost')}</th>
                        <th className={styles.numeric}>{t('settingsPage.usageCommon.tokens')}</th>
                        <th className={styles.numeric}>{t('settingsPage.usageCommon.requests')}</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => (
                        <tr key={`${row.vendor}-${row.model ?? ''}`}>
                            <td>{row.vendor}</td>
                            {showModel && <td>{row.model}</td>}
                            <td className={styles.numeric}>{formatUsd(row.costUsd)}</td>
                            <td className={styles.numeric}>{formatCount(row.totalTokens ?? 0)}</td>
                            <td className={styles.numeric}>{formatCount(row.requestCount)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )

    return (
        <div className={styles.container}>
            <DateRangePicker
                value={range}
                onChange={handleRangeChange}
                presets={usageDateRangePresets(t)}
                fromLabel={t('settingsPage.usageCommon.dateRangeFrom')}
                toLabel={t('settingsPage.usageCommon.dateRangeTo')}
                presetsAriaLabel={t('settingsPage.usageCommon.dateRangePresetsLabel')}
                data-testid="llm-usage-date-range"
            />

            {loading && (
                <p className={styles.statusText} data-testid="llm-usage-loading">
                    {t('settingsPage.usageCommon.loading')}
                </p>
            )}

            {!loading && error && (
                <p className={styles.statusTextError} data-testid="llm-usage-error">
                    {t('settingsPage.usageCommon.error')}
                </p>
            )}

            {!loading && !error && summary && (
                <>
                    <div className={styles.statTiles}>
                        <div className={styles.statTile} data-testid="llm-usage-total-cost">
                            <span className={styles.statLabel}>{t('settingsPage.usageCommon.totalCost')}</span>
                            <span className={styles.statValue}>{formatUsd(summary.totalCostUsd)}</span>
                        </div>
                        <div className={styles.statTile} data-testid="llm-usage-total-requests">
                            <span className={styles.statLabel}>{t('settingsPage.usageCommon.requests')}</span>
                            <span className={styles.statValue}>{formatCount(totalRequests)}</span>
                        </div>
                    </div>

                    {hasRows ? (
                        <>
                            <div className={styles.breakdownBlock}>
                                <h3 className={styles.breakdownTitle}>{t('settingsPage.usageCommon.byVendor')}</h3>
                                {renderRows(summary.byVendor, false)}
                            </div>
                            <div className={styles.breakdownBlock}>
                                <h3 className={styles.breakdownTitle}>{t('settingsPage.usageCommon.byModel')}</h3>
                                {renderRows(summary.byModel, true)}
                            </div>
                        </>
                    ) : (
                        <p className={styles.statusText} data-testid="llm-usage-empty">
                            {t('settingsPage.llmUsageSettings.empty')}
                        </p>
                    )}

                    <p className={styles.trackedSinceNote}>{t('settingsPage.llmUsageSettings.trackedSinceNote')}</p>
                </>
            )}
        </div>
    )
}
