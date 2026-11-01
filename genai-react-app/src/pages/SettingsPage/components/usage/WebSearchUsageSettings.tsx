import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateRangePicker, DateRange } from '@genflowly/component-library'
import { useAuth } from '../../../../context/AuthContext'
import { getWebSearchUsage, EstimatedUsageSummary } from '../../../../services/getUsageService'
import { defaultUsageRange, usageDateRangePresets } from './usageDateRange'
import { formatUsd, formatCount } from './usageFormat'
import { UsageNotTrackedYet } from './UsageNotTrackedYet'
import styles from './WebSearchUsageSettings.module.scss'

/**
 * Cost and Usage > Web Search. The response is always an ESTIMATE —
 * credit-count (basic=1, advanced=2 per Tavily call) × an admin-configurable
 * rate card, never a real bill from Tavily. The disclaimer banner must stay
 * visible whenever real data renders — explicit product requirement, not
 * optional copy.
 */
export function WebSearchUsageSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    const [range, setRange] = useState<DateRange>(defaultUsageRange)
    const [summary, setSummary] = useState<EstimatedUsageSummary | null>(null)
    const [loading, setLoading] = useState(false)

    const load = useCallback(async (nextRange: DateRange) => {
        if (!isAuthenticated) return
        setLoading(true)
        try {
            const token = await getAccessTokenSilently()
            const result = await getWebSearchUsage(token, nextRange)
            setSummary(result)
        } catch (err) {
            console.error('WebSearchUsageSettings: failed to fetch usage', err)
            setSummary(null)
        } finally {
            setLoading(false)
        }
    }, [isAuthenticated, getAccessTokenSilently])

    useEffect(() => {
        void load(range)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [range, load])

    const hasRows = !!summary && summary.breakdown.length > 0

    return (
        <div className={styles.container}>
            <DateRangePicker
                value={range}
                onChange={setRange}
                presets={usageDateRangePresets(t)}
                fromLabel={t('settingsPage.usageCommon.dateRangeFrom')}
                toLabel={t('settingsPage.usageCommon.dateRangeTo')}
                presetsAriaLabel={t('settingsPage.usageCommon.dateRangePresetsLabel')}
                data-testid="web-search-usage-date-range"
            />

            {loading && (
                <p className={styles.statusText} data-testid="web-search-usage-loading">
                    {t('settingsPage.usageCommon.loading')}
                </p>
            )}

            {!loading && !summary && <UsageNotTrackedYet data-testid="web-search-usage-not-tracked-yet" />}

            {!loading && summary && (
                <>
                    <p className={styles.estimateBanner} data-testid="web-search-usage-estimate-banner">
                        {t('settingsPage.usageCommon.estimateDisclaimer')}
                    </p>

                    <div className={styles.statTiles}>
                        <div className={styles.statTile} data-testid="web-search-usage-total-cost">
                            <span className={styles.statLabel}>{t('settingsPage.usageCommon.totalCost')}</span>
                            <span className={styles.statValue}>{formatUsd(summary.totalCostUsd)}</span>
                        </div>
                    </div>

                    {hasRows ? (
                        <div className={styles.breakdownBlock}>
                            <h3 className={styles.breakdownTitle}>
                                {t('settingsPage.webSearchUsageSettings.byDepth')}
                            </h3>
                            <div className={styles.tableScroll}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>{t('settingsPage.webSearchUsageSettings.searchDepth')}</th>
                                        <th className={styles.numeric}>
                                            {t('settingsPage.webSearchUsageSettings.credits')}
                                        </th>
                                        <th className={styles.numeric}>{t('settingsPage.usageCommon.totalCost')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {summary.breakdown.map(row => (
                                        <tr key={row.key}>
                                            <td>{row.key}</td>
                                            <td className={styles.numeric}>{formatCount(row.count)}</td>
                                            <td className={styles.numeric}>{formatUsd(row.costUsd)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            </div>
                        </div>
                    ) : (
                        <p className={styles.statusText} data-testid="web-search-usage-empty">
                            {t('settingsPage.webSearchUsageSettings.empty')}
                        </p>
                    )}
                </>
            )}
        </div>
    )
}
