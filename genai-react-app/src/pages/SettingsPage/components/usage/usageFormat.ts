/**
 * Costs are tracked to fractions of a cent (per-token pricing), so a flat
 * 2-decimal format would round small per-vendor/per-model rows to $0.00.
 * Switch to 4 decimals under $1; everything $1 and up reads as a normal price.
 */
export function formatUsd(value: number): string {
    const fractionDigits = Math.abs(value) < 1 ? 4 : 2
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
    }).format(value)
}

export function formatCount(value: number): string {
    return new Intl.NumberFormat('en-US').format(value)
}
