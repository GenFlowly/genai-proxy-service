import { defaultUsageRange, localToday, toUtcUsageRange, usageDateRangePresets } from './usageDateRange'

// These run under whatever timezone the test process has. Run the suite with
// TZ=America/Los_Angeles, UTC, Asia/Kolkata and Australia/Sydney to cover them all.
// Node reports Asia/Kolkata under its older name.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone.replace('Asia/Calcutta', 'Asia/Kolkata')
const inZone = <T extends { zone: string }>(cases: T[]): T[] => cases.filter(c => c.zone === zone)

const spanInDays = (from: string, to: string) =>
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000

describe('defaultUsageRange', () => {
    afterEach(() => jest.useRealTimers())

    test('spans exactly 30 local days, today included', () => {
        const range = defaultUsageRange()
        expect(spanInDays(range.from, range.to) + 1).toBe(30)
    })

    test('ends on the local date', () => {
        expect(defaultUsageRange().to).toBe(localToday())
    })

    test('stays 30 days at every hour across a daylight-saving change', () => {
        jest.useFakeTimers()
        for (let hour = 0; hour < 24; hour++) {
            jest.setSystemTime(new Date(Date.UTC(2026, 10, 4, hour)))
            const range = defaultUsageRange()
            expect(spanInDays(range.from, range.to) + 1).toBe(30)
        }
    })

    const moments = [
        { zone: 'America/Los_Angeles', now: '2026-11-05T00:01:00Z', from: '2026-10-06', to: '2026-11-04' },
        { zone: 'America/Los_Angeles', now: '2026-03-20T00:30:00Z', from: '2026-02-18', to: '2026-03-19' },
        { zone: 'UTC', now: '2026-11-05T00:01:00Z', from: '2026-10-07', to: '2026-11-05' },
        { zone: 'Asia/Kolkata', now: '2026-11-04T18:29:00Z', from: '2026-10-06', to: '2026-11-04' },
        { zone: 'Asia/Kolkata', now: '2026-11-04T18:31:00Z', from: '2026-10-07', to: '2026-11-05' },
        { zone: 'Australia/Sydney', now: '2026-11-04T13:30:00Z', from: '2026-10-07', to: '2026-11-05' },
    ]
    inZone(moments).forEach(({ now, from, to }) => {
        test(`in ${zone} at ${now} it shows ${from} to ${to}`, () => {
            jest.useFakeTimers()
            jest.setSystemTime(new Date(now))
            expect(defaultUsageRange()).toEqual({ from, to })
        })
    })
})

describe('toUtcUsageRange', () => {
    test('covers every instant of the local range', () => {
        const local = { from: '2026-11-01', to: '2026-11-04' }
        const utc = toUtcUsageRange(local)
        expect(utc.from <= new Date(2026, 10, 1).toISOString().slice(0, 10)).toBe(true)
        expect(utc.to >= new Date(2026, 10, 4, 23, 59, 59, 999).toISOString().slice(0, 10)).toBe(true)
    })

    test('asks for at most one extra UTC day', () => {
        const local = { from: '2026-10-06', to: '2026-11-04' }
        const utc = toUtcUsageRange(local)
        expect(spanInDays(utc.from, utc.to) - spanInDays(local.from, local.to)).toBeLessThanOrEqual(1)
    })

    const ranges = [
        { zone: 'America/Los_Angeles', from: '2026-11-04', to: '2026-11-04', utcFrom: '2026-11-04', utcTo: '2026-11-05' },
        { zone: 'America/Los_Angeles', from: '2026-10-06', to: '2026-11-04', utcFrom: '2026-10-06', utcTo: '2026-11-05' },
        { zone: 'UTC', from: '2026-11-04', to: '2026-11-04', utcFrom: '2026-11-04', utcTo: '2026-11-04' },
        { zone: 'Asia/Kolkata', from: '2026-11-04', to: '2026-11-04', utcFrom: '2026-11-03', utcTo: '2026-11-04' },
        { zone: 'Australia/Sydney', from: '2026-11-04', to: '2026-11-04', utcFrom: '2026-11-03', utcTo: '2026-11-04' },
    ]
    inZone(ranges).forEach(({ from, to, utcFrom, utcTo }) => {
        test(`in ${zone}, ${from} to ${to} asks for ${utcFrom} to ${utcTo}`, () => {
            expect(toUtcUsageRange({ from, to })).toEqual({ from: utcFrom, to: utcTo })
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
