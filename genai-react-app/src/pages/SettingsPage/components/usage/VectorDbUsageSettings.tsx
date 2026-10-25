import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateRangePicker, DateRange } from '@genflowly/component-library'
import { useAuth } from '../../../../context/AuthContext'
import { getVectorDbUsage, EstimatedUsageSummary } from '../../../../services/getUsageService'
import { defaultUsageRange, usageDateRangePresets } from './usageDateRange'
import { formatUsd, formatCount } from './usageFormat'
import { UsageNotTrackedYet } from './UsageNotTrackedYet'
import styles from './VectorDbUsageSettings.module.scss'

/**
 * Cost and Usage > Vector DB. The response is always an ESTIMATE — op-count
 * (search/query/insert/upsert/delete) × an admin-configurable rate card,
 * never a real bill from the customer's own Zilliz cluster (we never see
 * it). The disclaimer banner must stay visible whenever real data renders —
 * explicit product requirement, not optional copy.
 */
export function VectorDbUsageSettings(): React.ReactElement {
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
            const result = await getVectorDbUsage(token, nextRange)
            setSummary(result)
        } catch (err) {
            console.error('VectorDbUsageSettings: failed to fetch usage', err)
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
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.vectorDbUsageSettings.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.vectorDbUsageSettings.subtitle')}</p>
            </div>

            <DateRangePicker
                value={range}
                onChange={setRange}
                presets={usageDateRangePresets(t)}
                fromLabel={t('settingsPage.usageCommon.dateRangeFrom')}
                toLabel={t('settingsPage.usageCommon.dateRangeTo')}
                presetsAriaLabel={t('settingsPage.usageCommon.dateRangePresetsLabel')}
                data-testid="vector-db-usage-date-range"
            />

            {loading && (
                <p className={styles.statusText} data-testid="vector-db-usage-loading">
                    {t('settingsPage.usageCommon.loading')}
                </p>
            )}

            {!loading && !summary && <UsageNotTrackedYet data-testid="vector-db-usage-not-tracked-yet" />}

            {!loading && summary && (
                <>
                    <p className={styles.estimateBanner} data-testid="vector-db-usage-estimate-banner">
                        {t('settingsPage.usageCommon.estimateDisclaimer')}
                    </p>

                    <div className={styles.statTiles}>
                        <div className={styles.statTile} data-testid="vector-db-usage-total-cost">
                            <span className={styles.statLabel}>{t('settingsPage.usageCommon.totalCost')}</span>
                            <span className={styles.statValue}>{formatUsd(summary.totalCostUsd)}</span>
                        </div>
                    </div>

                    {hasRows ? (
                        <div className={styles.breakdownBlock}>
                            <h3 className={styles.breakdownTitle}>
                                {t('settingsPage.vectorDbUsageSettings.byOperation')}
                            </h3>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>{t('settingsPage.vectorDbUsageSettings.operation')}</th>
                                        <th className={styles.numeric}>
                                            {t('settingsPage.vectorDbUsageSettings.operationCount')}
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
                    ) : (
                        <p className={styles.statusText} data-testid="vector-db-usage-empty">
                            {t('settingsPage.vectorDbUsageSettings.empty')}
                        </p>
                    )}
                </>
            )}
        </div>
    )
}
