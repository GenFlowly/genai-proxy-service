import { useWindowSize } from './useWindowSize'

export function useMaxVendors(): number {
    const { width } = useWindowSize()

    if (width >= 2280) {
        return 3
    }
    if (width >= 1366) {
        return 2
    }
    return 1
}
