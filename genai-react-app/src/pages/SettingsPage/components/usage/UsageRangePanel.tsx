import React, { useState } from 'react'
import { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { DateRange, DateRangePicker, SettingsCard } from '@genflowly/component-library'
import { defaultUsageRange, localToday, usageDateRangePresets } from './usageDateRange'

const DAY_MS = 86_400_000

/** "Last 30 days" when the range is a preset ending today, else the two local dates. */
export function usageRangeLabel(range: DateRange, t: TFunction): string {
    if (range.to === localToday()) {
        const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY_MS) + 1
        const preset = usageDateRangePresets(t).find(option => option.days === days)
        if (preset) return preset.label
    }
    return `${localDate(range.from)} – ${localDate(range.to)}`
}

function localDate(isoDate: string): string {
    const [year, month, day] = isoDate.split('-').map(Number)
    return new Date(year, month - 1, day).toLocaleDateString()
}

/** The picked range (trailing 30 local days at first) and its header label. */
export function useUsageRange(): { range: DateRange; setRange: (range: DateRange) => void; label: string } {
    const { t } = useTranslation()
    const [range, setRange] = useState<DateRange>(defaultUsageRange)
    return { range, setRange, label: usageRangeLabel(range, t) }
}

interface UsageRangePanelProps {
    range: DateRange
    onChange: (range: DateRange) => void
    'data-testid'?: string
}

/** The date range picker every Cost and Usage page starts with, in a headerless card. */
export function UsageRangePanel({ range, onChange, 'data-testid': testId }: UsageRangePanelProps): React.ReactElement {
    const { t } = useTranslation()
    return (
        <SettingsCard aria-label={t('settingsPage.usageCommon.dateRangePresetsLabel')}>
            <DateRangePicker
                value={range}
                onChange={onChange}
                presets={usageDateRangePresets(t)}
                maxDate={localToday()}
                fromLabel={t('settingsPage.usageCommon.dateRangeFrom')}
                toLabel={t('settingsPage.usageCommon.dateRangeTo')}
                presetsAriaLabel={t('settingsPage.usageCommon.dateRangePresetsLabel')}
                variant="toolbar"
                data-testid={testId}
            />
        </SettingsCard>
    )
}
