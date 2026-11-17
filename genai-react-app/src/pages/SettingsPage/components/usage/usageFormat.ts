/**
 * Costs are tracked to fractions of a cent (per-token pricing), so a flat
 * 2-decimal format would round small per-vendor/per-model rows to $0.00.
 * Under $1 it keeps up to 4 decimals ("$0.21", "$0.0034"); $1 and up reads as a normal price.
 */
/**
 * Chart labels: costs under a cent keep two significant digits so a bar of
 * $0.00004 doesn't read "$0.00"; anything larger reads like formatUsd.
 */
export function formatChartUsd(value: number): string {
    if (value === 0) return '$0'
    if (Math.abs(value) >= 0.01) return formatUsd(value)
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumSignificantDigits: 2,
    }).format(value)
}

export function formatUsd(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2,
    }).format(value)
}
