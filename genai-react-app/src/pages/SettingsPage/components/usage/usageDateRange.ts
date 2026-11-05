import { TFunction } from 'i18next'
import { DateRange, DateRangePreset } from '@genflowly/component-library'

function toIsoDate(d: Date): string {
    return d.toISOString().slice(0, 10)
}

/** Today in the device's timezone: the latest day the picker can show. */
export function localToday(): string {
    const now = new Date()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${now.getFullYear()}-${month}-${day}`
}

/** Initial window shown on first load: the trailing 30 local days, today included. */
export function defaultUsageRange(): DateRange {
    const to = localToday()
    const from = new Date(`${to}T00:00:00Z`)
    from.setUTCDate(from.getUTCDate() - 29)
    return { from: toIsoDate(from), to }
}

/**
 * The picker shows local days, but usage is stored per whole UTC day and a local
 * day overlaps two of them. This asks for every UTC day the local range touches,
 * so usage is never left out, though totals can include a few hours at each end.
 */
export function toUtcUsageRange(range: DateRange): DateRange {
    const [fromYear, fromMonth, fromDay] = range.from.split('-').map(Number)
    const [toYear, toMonth, toDay] = range.to.split('-').map(Number)
    return {
        from: toIsoDate(new Date(fromYear, fromMonth - 1, fromDay)),
        to: toIsoDate(new Date(toYear, toMonth - 1, toDay, 23, 59, 59, 999)),
    }
}

/** Shared, localized preset set for every Cost and Usage page's date picker. */
export function usageDateRangePresets(t: TFunction): DateRangePreset[] {
    return [
        { id: '7d', label: t('settingsPage.usageCommon.dateRangeLast7Days'), days: 7 },
        { id: '30d', label: t('settingsPage.usageCommon.dateRangeLast30Days'), days: 30 },
        { id: '90d', label: t('settingsPage.usageCommon.dateRangeLast90Days'), days: 90 },
    ]
}
