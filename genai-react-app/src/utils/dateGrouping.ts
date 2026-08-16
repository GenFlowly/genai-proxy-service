import { parseServerDate } from './timeUtils'

export type DateGroupId = 'today' | 'yesterday' | 'last7Days' | 'older'

export interface DateGroup<T> {
    id: DateGroupId
    items: T[]
}

/**
 * Bucket items into Today / Yesterday / Last 7 days / Older by a server
 * timestamp. Items with an unparseable date land in Today (treated as "now").
 * Empty groups are dropped.
 */
export function groupByDate<T>(
    items: T[],
    getDate: (item: T) => string | number | Date | null | undefined
): DateGroup<T>[] {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    const last7Days = new Date(today)
    last7Days.setDate(last7Days.getDate() - 7)

    const groups: DateGroup<T>[] = [
        { id: 'today', items: [] },
        { id: 'yesterday', items: [] },
        { id: 'last7Days', items: [] },
        { id: 'older', items: [] },
    ]

    items.forEach(item => {
        const d = parseServerDate(getDate(item)) ?? new Date()
        if (d >= today) {
            groups[0].items.push(item)
        } else if (d >= yesterday) {
            groups[1].items.push(item)
        } else if (d >= last7Days) {
            groups[2].items.push(item)
        } else {
            groups[3].items.push(item)
        }
    })

    return groups.filter(g => g.items.length > 0)
}
