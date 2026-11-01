import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateRangePicker, DateRange } from '@genflowly/component-library'
import { useAuth } from '../../../../context/AuthContext'
import { getVectorDbUsage, VectorDbUsageSummary } from '../../../../services/getUsageService'
import { defaultUsageRange, usageDateRangePresets } from './usageDateRange'
import { formatCount } from './usageFormat'
import { UsageNotTrackedYet } from './UsageNotTrackedYet'
import styles from './VectorDbUsageSettings.module.scss'

/**
 * Cost and Usage > Vector DB. No cost figure is ever shown here — Zilliz
 * bills by data size/compute units on the customer's own cluster, not per
 * operation call, so an op count can't be converted into a meaningful
 * dollar estimate. This page shows raw search/query/insert/upsert/delete
 * counts only.
 */
export function VectorDbUsageSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    const [range, setRange] = useState<DateRange>(defaultUsageRange)
    const [summary, setSummary] = useState<VectorDbUsageSummary | null>(null)
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
                    <p className={styles.noCostNote} data-testid="vector-db-usage-no-cost-note">
                        {t('settingsPage.vectorDbUsageSettings.noCostNote')}
                    </p>

                    {hasRows ? (
                        <div className={styles.breakdownBlock}>
                            <h3 className={styles.breakdownTitle}>
                                {t('settingsPage.vectorDbUsageSettings.byOperation')}
                            </h3>
                            <div className={styles.tableScroll}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>{t('settingsPage.vectorDbUsageSettings.operation')}</th>
                                        <th className={styles.numeric}>
                                            {t('settingsPage.vectorDbUsageSettings.operationCount')}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {summary.breakdown.map(row => (
                                        <tr key={row.opType}>
                                            <td>{row.opType}</td>
                                            <td className={styles.numeric}>{formatCount(row.count)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            </div>
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
