import i18n from 'i18next'
import { usageRangeLabel } from './UsageRangePanel'
import { localToday } from './usageDateRange'
import { formatChartUsd, formatUsd } from './usageFormat'

const daysBefore = (isoDate: string, days: number) => {
    const date = new Date(`${isoDate}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - days)
    return date.toISOString().slice(0, 10)
}

describe('usageRangeLabel', () => {
    const t = i18n.t.bind(i18n)

    test('names a preset that ends today', () => {
        const today = localToday()
        expect(usageRangeLabel({ from: daysBefore(today, 29), to: today }, t)).toBe('Last 30 days')
        expect(usageRangeLabel({ from: daysBefore(today, 89), to: today }, t)).toBe('Last 90 days')
    })

    test('shows the two dates for any other range', () => {
        const label = usageRangeLabel({ from: '2026-10-01', to: '2026-10-15' }, t)
        expect(label).toBe(`${new Date(2026, 9, 1).toLocaleDateString()} – ${new Date(2026, 9, 15).toLocaleDateString()}`)
    })
})

describe('usage money formats', () => {
    test('prices keep two decimals, and up to four under a dollar', () => {
        expect(formatUsd(4.123)).toBe('$4.12')
        expect(formatUsd(0.21)).toBe('$0.21')
        expect(formatUsd(0.0034)).toBe('$0.0034')
    })

    test('chart labels keep tiny costs readable', () => {
        expect(formatChartUsd(0)).toBe('$0')
        expect(formatChartUsd(0.000052)).toBe('$0.000052')
        expect(formatChartUsd(0.4378)).toBe('$0.4378')
        expect(formatChartUsd(12.5)).toBe('$12.50')
    })
})
