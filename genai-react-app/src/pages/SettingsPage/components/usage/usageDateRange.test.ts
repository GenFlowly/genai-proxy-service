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

    describe('across a daylight-saving change', () => {
        beforeEach(() => jest.useFakeTimers())
        afterEach(() => jest.useRealTimers())

        test.each([
            ['2026-11-05T00:01:00Z', '2026-10-07', '2026-11-05'],
            ['2026-11-04T23:59:00Z', '2026-10-06', '2026-11-04'],
            ['2026-03-20T00:30:00Z', '2026-02-19', '2026-03-20'],
        ])('at %s it runs from %s to %s', (now, from, to) => {
            jest.setSystemTime(new Date(now))
            expect(defaultUsageRange()).toEqual({ from, to })
        })
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
