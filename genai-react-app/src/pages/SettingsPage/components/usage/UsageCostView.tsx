import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
    BarChart,
    BarChartPoint,
    DataTable,
    DataTableColumn,
    DateRange,
    Grid,
    GridCol,
    SettingsCard,
    StatTile,
    StatusPill,
    bucketDailySeries,
    formatCompactCount,
} from '@genflowly/component-library'
import { useHasOwnKeys } from '../../../../hooks/useHasOwnKeys'
import { useVendorDisplayNames } from '../../../../hooks/useVendorDisplayNames'
import { UsageByDay, UsageByDim } from '../../../../services/getUsageService'
import { SettingsFrame } from '../SettingsFrame'
import { useSettingsShell } from '../../SettingsShellContext'
import { formatChartUsd, formatUsd } from './usageFormat'
import { UsageRangePanel, useUsageRange } from './UsageRangePanel'
import { useUsageSummary } from './useUsageSummary'
import { UsageNotTrackedYet } from './UsageNotTrackedYet'
import styles from './UsageCostView.module.scss'

export interface UsageCostSummary {
    totalCostUsd: number
    byVendor: UsageByDim[]
    byModel: UsageByDim[]
    byDay?: UsageByDay[]
}

interface UsageCostViewProps {
    /** Settings page id, for the frame's breadcrumb and title. */
    page: string
    knowledge: { title: string; text: string }[]
    /** Fetches the UTC range; null means nothing to show. */
    load: (token: string, range: DateRange) => Promise<UsageCostSummary | null>
    /** Adds the Cache tokens tile (LLM models only). */
    showCacheTokens?: boolean
    /** Vendor names for the tables; defaults to the chat provider catalog. */
    vendorName?: (vendor: string) => string
    'data-testid': string
}

const sum = (rows: UsageByDim[], pick: (row: UsageByDim) => number | null | undefined) =>
    rows.reduce((total, row) => total + (pick(row) ?? 0), 0)

/**
 * Days are stored per whole UTC day, and a local range touches one more UTC
 * day at one end. Those days fold into the nearest bar so the chart adds up
 * to the tiles.
 */
function clampedDays(days: UsageByDay[], range: DateRange) {
    const totals = new Map<string, { value: number; count: number }>()
    days.forEach(day => {
        const date = day.date < range.from ? range.from : day.date > range.to ? range.to : day.date
        const current = totals.get(date) ?? { value: 0, count: 0 }
        totals.set(date, { value: current.value + day.costUsd, count: current.count + day.requestCount })
    })
    return Array.from(totals, ([date, total]) => ({ date, ...total }))
}

const utcDate = (isoDate: string, options: Intl.DateTimeFormatOptions) =>
    new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' })

/**
 * The LLM and Embedding usage pages: date range, headline tiles, cost per
 * day (per week past 60 days), and by-vendor and by-model tables. Own-key
 * customers see the cost as an estimate.
 */
export function UsageCostView({ page, knowledge, load, showCacheTokens = false, vendorName, 'data-testid': testId }: UsageCostViewProps): React.ReactElement {
    const { t } = useTranslation()
    const hasOwnKeys = useHasOwnKeys()
    const { narrow } = useSettingsShell()
    const vendorDisplayName = useVendorDisplayNames()
    const { range, setRange, label } = useUsageRange()
    const { summary, loading, error } = useUsageSummary(load, range, testId)

    const costLabel = hasOwnKeys ? t('settingsPage.usageCommon.estCost') : t('settingsPage.usageCommon.totalCost')
    const series = useMemo(
        () => bucketDailySeries(clampedDays(summary?.byDay ?? [], range), range.from, range.to),
        [summary, range]
    )
    const points: BarChartPoint[] = series.buckets.map(bucket => ({
        key: bucket.start,
        value: bucket.value,
        axisLabel: utcDate(bucket.start, { month: 'short', day: 'numeric' }),
        tooltipTitle: series.bucket === 'week'
            ? `${utcDate(bucket.start, { month: 'short', day: 'numeric' })} – ${utcDate(bucket.end, { month: 'short', day: 'numeric' })}`
            : utcDate(bucket.start, { weekday: 'short', month: 'short', day: 'numeric' }),
        tooltipDetail: t('settingsPage.usageCommon.requestsCount', { count: bucket.count, formatted: formatCompactCount(bucket.count) }),
    }))
    const chartTitle = series.bucket === 'week' ? t('settingsPage.usageCommon.costPerWeek') : t('settingsPage.usageCommon.costPerDay')

    const figures: DataTableColumn<UsageByDim>[] = [
        { key: 'cost', header: costLabel, numeric: true, render: row => formatUsd(row.costUsd) },
        { key: 'tokens', header: t('settingsPage.usageCommon.tokens'), numeric: true, render: row => formatCompactCount(row.totalTokens ?? 0) },
        { key: 'requests', header: t('settingsPage.usageCommon.requests'), numeric: true, render: row => formatCompactCount(row.requestCount) },
    ]
    const vendorColumn: DataTableColumn<UsageByDim> = {
        key: 'vendor', header: t('settingsPage.usageCommon.vendor'), render: row => (vendorName ?? vendorDisplayName)(row.vendor),
    }
    const modelColumn: DataTableColumn<UsageByDim> = {
        key: 'model', header: t('settingsPage.usageCommon.model'), render: row => row.model,
    }

    const byVendor = summary?.byVendor ?? []
    const tiles = [
        { key: 'cost', label: costLabel, value: formatUsd(summary?.totalCostUsd ?? 0) },
        { key: 'requests', label: t('settingsPage.usageCommon.requests'), value: formatCompactCount(sum(byVendor, row => row.requestCount)) },
        { key: 'tokens', label: t('settingsPage.usageCommon.tokens'), value: formatCompactCount(sum(byVendor, row => row.totalTokens)) },
        ...(showCacheTokens ? [{
            key: 'cache',
            label: t('settingsPage.usageCommon.cacheTokens'),
            value: formatCompactCount(sum(byVendor, row => (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0))),
        }] : []),
    ]
    const tileSpan = (12 / tiles.length) as 3 | 4
    const statusText = !loading && !error && !summary ? t('settingsPage.usageCommon.notTrackedYetTitle') : label

    return (
        <SettingsFrame page={page} knowledge={knowledge} statusText={statusText} status={<StatusPill>{statusText}</StatusPill>}>
            <UsageRangePanel range={range} onChange={setRange} data-testid={`${testId}-date-range`} />

            {loading && <p className={styles.statusText} data-testid={`${testId}-loading`}>{t('settingsPage.usageCommon.loading')}</p>}
            {!loading && error && <p className={styles.statusText} role="alert" data-testid={`${testId}-error`}>{t('settingsPage.usageCommon.error')}</p>}

            {!loading && !error && !summary && <UsageNotTrackedYet data-testid={`${testId}-not-tracked-yet`} />}

            {!loading && !error && summary && (
                <>
                    <Grid gap="sm" className={narrow ? styles.tilesNarrow : undefined}>
                        {tiles.map(tile => (
                            <GridCol key={tile.key} span={6} md={tileSpan}>
                                <StatTile label={tile.label} value={tile.value} data-testid={`${testId}-tile-${tile.key}`} />
                            </GridCol>
                        ))}
                    </Grid>
                    <SettingsCard title={chartTitle}>
                        <BarChart
                            points={points}
                            formatValue={formatChartUsd}
                            aria-label={chartTitle}
                            data-testid={`${testId}-chart`}
                        />
                    </SettingsCard>
                    <SettingsCard title={t('settingsPage.usageCommon.byVendor')} flush>
                        <DataTable
                            columns={[vendorColumn, ...figures]}
                            rows={byVendor}
                            rowKey={row => row.vendor}
                            caption={t('settingsPage.usageCommon.byVendor')}
                            emptyText={t('settingsPage.usageCommon.noUsage')}
                            data-testid={`${testId}-by-vendor`}
                        />
                    </SettingsCard>
                    <SettingsCard title={t('settingsPage.usageCommon.byModel')} flush>
                        <DataTable
                            columns={[vendorColumn, modelColumn, ...figures]}
                            rows={summary?.byModel ?? []}
                            rowKey={row => `${row.vendor}-${row.model ?? ''}`}
                            caption={t('settingsPage.usageCommon.byModel')}
                            emptyText={t('settingsPage.usageCommon.noUsage')}
                            data-testid={`${testId}-by-model`}
                        />
                    </SettingsCard>
                </>
            )}
        </SettingsFrame>
    )
}
