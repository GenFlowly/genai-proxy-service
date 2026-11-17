import React from 'react'
import { useTranslation } from 'react-i18next'
import { DataTable, SettingsCard, StatusPill, formatCompactCount } from '@genflowly/component-library'
import { EstimatedUsageBreakdownRow, getWebSearchUsage } from '../../../../services/getUsageService'
import { SettingsFrame } from '../SettingsFrame'
import { UsageRangePanel, useUsageRange } from './UsageRangePanel'
import { UsageNotTrackedYet } from './UsageNotTrackedYet'
import { useUsageSummary } from './useUsageSummary'
import { formatUsd } from './usageFormat'
import styles from './UsageCostView.module.scss'

/**
 * Cost and Usage › Web Search: each web search the assistant ran. Its cost
 * is always an estimate (search credits at a set rate), so it is labelled
 * that way. Until the route ships it shows "Not tracked yet".
 */
export function WebSearchUsageSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { range, setRange, label } = useUsageRange()
    const { summary, loading } = useUsageSummary(getWebSearchUsage, range, 'WebSearchUsageSettings')
    const statusText = !loading && !summary ? t('settingsPage.usageCommon.notTrackedYetTitle') : label
    const knowledge = [
        { title: t('settingsPage.webSearchUsageSettings.countedTitle'), text: t('settingsPage.webSearchUsageSettings.countedText') },
        { title: t('settingsPage.webSearchUsageSettings.spendTitle'), text: t('settingsPage.webSearchUsageSettings.spendText') },
    ]

    return (
        <SettingsFrame page="usage-web-search" knowledge={knowledge} statusText={statusText} status={<StatusPill>{statusText}</StatusPill>}>
            <UsageRangePanel range={range} onChange={setRange} data-testid="web-search-usage-date-range" />
            {loading && <p className={styles.statusText} data-testid="web-search-usage-loading">{t('settingsPage.usageCommon.loading')}</p>}
            {!loading && !summary && (
                <UsageNotTrackedYet
                    link={{ to: '/settings/byok/web-search', label: t('settingsPage.webSearchUsageSettings.changeLimit') }}
                    data-testid="web-search-usage-not-tracked-yet"
                />
            )}
            {!loading && summary && (
                <SettingsCard title={t('settingsPage.webSearchUsageSettings.byDepth')} flush>
                    <DataTable<EstimatedUsageBreakdownRow>
                        columns={[
                            { key: 'depth', header: t('settingsPage.webSearchUsageSettings.searchDepth'), render: row => row.key },
                            { key: 'credits', header: t('settingsPage.webSearchUsageSettings.credits'), numeric: true, render: row => formatCompactCount(row.count) },
                            { key: 'cost', header: t('settingsPage.usageCommon.estCost'), numeric: true, render: row => formatUsd(row.costUsd) },
                        ]}
                        rows={summary.breakdown}
                        rowKey={row => row.key}
                        caption={t('settingsPage.webSearchUsageSettings.byDepth')}
                        emptyText={t('settingsPage.usageCommon.noUsage')}
                        footer={[t('settingsPage.usageCommon.total'), '', formatUsd(summary.totalCostUsd)]}
                        data-testid="web-search-usage-table"
                    />
                </SettingsCard>
            )}
        </SettingsFrame>
    )
}
