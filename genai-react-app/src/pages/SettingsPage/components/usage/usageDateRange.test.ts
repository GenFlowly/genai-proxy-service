import { defaultUsageRange, usageDateRangePresets } from './usageDateRange'

describe('defaultUsageRange', () => {
    test('spans exactly 30 days, today included', () => {
        const range = defaultUsageRange()
        const days =
            (new Date(`${range.to}T00:00:00Z`).getTime() - new Date(`${range.from}T00:00:00Z`).getTime()) /
                86400000 +
            1
        expect(days).toBe(30)
    })

    test('ends today', () => {
        const range = defaultUsageRange()
        const todayIso = new Date().toISOString().slice(0, 10)
        expect(range.to).toBe(todayIso)
    })
})

describe('usageDateRangePresets', () => {
    test('builds 7/30/90-day presets using the provided translator', () => {
        const t = (key: string) => key
        const presets = usageDateRangePresets(t as never)

        expect(presets).toEqual([
            { id: '7d', label: 'settingsPage.usageCommon.dateRangeLast7Days', days: 7 },
            { id: '30d', label: 'settingsPage.usageCommon.dateRangeLast30Days', days: 30 },
            { id: '90d', label: 'settingsPage.usageCommon.dateRangeLast90Days', days: 90 },
        ])
    })
})
