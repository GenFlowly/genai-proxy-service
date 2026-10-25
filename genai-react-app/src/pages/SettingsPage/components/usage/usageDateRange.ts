import { TFunction } from 'i18next'
import { DateRange, DateRangePreset } from '@genflowly/component-library'

function toIsoDate(d: Date): string {
    return d.toISOString().slice(0, 10)
}

/** Initial window shown on first load: the trailing 30 days, today included. */
export function defaultUsageRange(): DateRange {
    const to = new Date()
    const from = new Date(to)
    from.setDate(from.getDate() - 29)
    return { from: toIsoDate(from), to: toIsoDate(to) }
}

/** Shared, localized preset set for every Cost and Usage page's date picker. */
export function usageDateRangePresets(t: TFunction): DateRangePreset[] {
    return [
        { id: '7d', label: t('settingsPage.usageCommon.dateRangeLast7Days'), days: 7 },
        { id: '30d', label: t('settingsPage.usageCommon.dateRangeLast30Days'), days: 30 },
        { id: '90d', label: t('settingsPage.usageCommon.dateRangeLast90Days'), days: 90 },
    ]
}
