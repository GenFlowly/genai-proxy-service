/**
 * Global server-timestamp converter.
 *
 * All timestamps produced by the backend are UTC, but some are serialized
 * without an explicit zone suffix (e.g. "2026-08-15T07:38:54"). JavaScript
 * parses zone-less date-time strings as LOCAL time, which silently displays
 * UTC wall-clock values as if they were local. Every timestamp coming from
 * the server must therefore be parsed via parseServerDate, which forces UTC
 * when no zone info is present; the format helpers then render in the
 * device's local timezone and locale (the Intl defaults).
 *
 * The server stays untouched — the app adapts.
 */

/** Trailing zone designator: Z, +05:30, -0800, ... */
const HAS_ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i

/** Something that looks like an ISO date-time: 2026-08-15T07:38 / 2026-08-15 07:38 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

export function parseServerDate(value: string | number | Date | null | undefined): Date | null {
    if (value == null) return null

    if (value instanceof Date) {
        return isNaN(value.getTime()) ? null : value
    }

    // Epoch milliseconds are absolute — no zone ambiguity
    if (typeof value === 'number') {
        const d = new Date(value)
        return isNaN(d.getTime()) ? null : d
    }

    const s = value.trim()
    if (!s) return null

    // Zone-less ISO date-times are UTC on our backend: normalize before parsing
    const normalized = ISO_DATETIME_RE.test(s) && !HAS_ZONE_RE.test(s)
        ? `${s.replace(' ', 'T')}Z`
        : s

    const d = new Date(normalized)
    return isNaN(d.getTime()) ? null : d
}

/** Format with explicit Intl options; empty string when unparseable. */
export function formatServerTimestamp(
    value: string | number | Date | null | undefined,
    options: Intl.DateTimeFormatOptions
): string {
    const d = parseServerDate(value)
    return d ? d.toLocaleString([], options) : ''
}

/** "Aug 15, 2026, 03:42 PM" (device locale/timezone) */
export function formatServerDateTime(value: string | number | Date | null | undefined): string {
    return formatServerTimestamp(value, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

/** "03:42 PM" (device locale/timezone) */
export function formatServerTime(value: string | number | Date | null | undefined): string {
    return formatServerTimestamp(value, { hour: '2-digit', minute: '2-digit' })
}

/** "Aug 15, 2026" (device locale/timezone) */
export function formatServerDateOnly(value: string | number | Date | null | undefined): string {
    return formatServerTimestamp(value, { year: 'numeric', month: 'short', day: 'numeric' })
}
