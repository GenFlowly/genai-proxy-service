import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateRangePicker, DateRange } from '@genflowly/component-library'
import { useAuth } from '../../../../context/AuthContext'
import { getEmbeddingUsage, EmbeddingUsageSummary, UsageByDim } from '../../../../services/getUsageService'
import { defaultUsageRange, localToday, toUtcUsageRange, usageDateRangePresets } from './usageDateRange'
import { formatUsd, formatCount } from './usageFormat'
import { UsageNotTrackedYet } from './UsageNotTrackedYet'
import styles from './EmbeddingUsageSettings.module.scss'

/**
 * Cost and Usage > Embedding Models. The backend route (Routes.USAGE_EMBEDDING)
 * is live — a 404 (or any fetch failure) still means "not tracked yet" rather
 * than an error, since an older deploy or a not-yet-synced catalog can
 * legitimately return nothing for this customer yet.
 */
export function EmbeddingUsageSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    const [range, setRange] = useState<DateRange>(defaultUsageRange)
    const [summary, setSummary] = useState<EmbeddingUsageSummary | null>(null)
    const [loading, setLoading] = useState(false)

    const load = useCallback(async (nextRange: DateRange) => {
        if (!isAuthenticated) return
        setLoading(true)
        try {
            const token = await getAccessTokenSilently()
            const result = await getEmbeddingUsage(token, toUtcUsageRange(nextRange))
            setSummary(result)
        } catch (err) {
            // Any failure reads the same as "not tracked yet" to the customer;
            // log it so a real regression is still visible.
            console.error('EmbeddingUsageSettings: failed to fetch usage', err)
            setSummary(null)
        } finally {
            setLoading(false)
        }
    }, [isAuthenticated, getAccessTokenSilently])

    useEffect(() => {
        void load(range)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [range, load])

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
                onChange={setRange}
                presets={usageDateRangePresets(t)}
                maxDate={localToday()}
                fromLabel={t('settingsPage.usageCommon.dateRangeFrom')}
                toLabel={t('settingsPage.usageCommon.dateRangeTo')}
                presetsAriaLabel={t('settingsPage.usageCommon.dateRangePresetsLabel')}
                data-testid="embedding-usage-date-range"
            />

            {loading && (
                <p className={styles.statusText} data-testid="embedding-usage-loading">
                    {t('settingsPage.usageCommon.loading')}
                </p>
            )}

            {!loading && !summary && <UsageNotTrackedYet data-testid="embedding-usage-not-tracked-yet" />}

            {!loading && summary && (
                <>
                    <div className={styles.statTiles}>
                        <div className={styles.statTile} data-testid="embedding-usage-total-cost">
                            <span className={styles.statLabel}>{t('settingsPage.usageCommon.totalCost')}</span>
                            <span className={styles.statValue}>{formatUsd(summary.totalCostUsd)}</span>
                        </div>
                        <div className={styles.statTile} data-testid="embedding-usage-total-requests">
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
                        <p className={styles.statusText} data-testid="embedding-usage-empty">
                            {t('settingsPage.embeddingUsageSettings.empty')}
                        </p>
                    )}
                </>
            )}
        </div>
    )
}
