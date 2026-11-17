import React from 'react'
import { useTranslation } from 'react-i18next'
import { DataTable, SettingsCard, StatusPill, formatCompactCount } from '@genflowly/component-library'
import { getVectorDbUsage, VectorDbUsageBreakdownRow } from '../../../../services/getUsageService'
import { SettingsFrame } from '../SettingsFrame'
import { UsageRangePanel, useUsageRange } from './UsageRangePanel'
import { UsageNotTrackedYet } from './UsageNotTrackedYet'
import { useUsageSummary } from './useUsageSummary'
import styles from './UsageCostView.module.scss'

/**
 * Cost and Usage › Vector DB: how often the customer's database saves,
 * searches and deletes. Counts only, never a cost: the database is billed
 * by size, not per call. Until the route ships it shows "Not tracked yet".
 */
export function VectorDbUsageSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { range, setRange, label } = useUsageRange()
    const { summary, loading } = useUsageSummary(getVectorDbUsage, range, 'VectorDbUsageSettings')
    const statusText = !loading && !summary ? t('settingsPage.usageCommon.notTrackedYetTitle') : label
    const knowledge = [
        { title: t('settingsPage.vectorDbUsageSettings.countedTitle'), text: t('settingsPage.vectorDbUsageSettings.countedText') },
        { title: t('settingsPage.vectorDbUsageSettings.noCostTitle'), text: t('settingsPage.vectorDbUsageSettings.noCostText') },
    ]

    return (
        <SettingsFrame page="usage-vector-db" knowledge={knowledge} statusText={statusText} status={<StatusPill>{statusText}</StatusPill>}>
            <UsageRangePanel range={range} onChange={setRange} data-testid="vector-db-usage-date-range" />
            {loading && <p className={styles.statusText} data-testid="vector-db-usage-loading">{t('settingsPage.usageCommon.loading')}</p>}
            {!loading && !summary && (
                <UsageNotTrackedYet
                    link={{ to: '/settings/byok/vector-db', label: t('settingsPage.nav.vectorDb') }}
                    data-testid="vector-db-usage-not-tracked-yet"
                />
            )}
            {!loading && summary && (
                <SettingsCard title={t('settingsPage.vectorDbUsageSettings.byOperation')} flush>
                    <DataTable<VectorDbUsageBreakdownRow>
                        columns={[
                            { key: 'op', header: t('settingsPage.vectorDbUsageSettings.operation'), render: row => row.opType },
                            { key: 'count', header: t('settingsPage.vectorDbUsageSettings.operationCount'), numeric: true, render: row => formatCompactCount(row.count) },
                        ]}
                        rows={summary.breakdown}
                        rowKey={row => row.opType}
                        caption={t('settingsPage.vectorDbUsageSettings.byOperation')}
                        emptyText={t('settingsPage.usageCommon.noUsage')}
                        data-testid="vector-db-usage-table"
                    />
                </SettingsCard>
            )}
        </SettingsFrame>
    )
}
