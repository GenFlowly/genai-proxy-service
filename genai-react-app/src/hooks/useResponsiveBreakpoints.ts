import { useWindowSize } from './useWindowSize'
import { MOBILE_BREAKPOINT, NARROW_BREAKPOINT } from '../constants/breakpoints'

export interface ResponsiveBreakpoints {
    width: number
    height: number
    /** Phone-sized viewport — for CSS-density-only decisions. */
    isMobile: boolean
    /** No room for a persistent side panel — use full-screen mobile-style chrome. */
    isNarrow: boolean
}

/**
 * Single source of truth for the isMobile/isNarrow checks every page used to
 * re-derive independently from useWindowSize.
 */
export function useResponsiveBreakpoints(): ResponsiveBreakpoints {
    const { width, height } = useWindowSize()
    return {
        width,
        height,
        isMobile: width <= MOBILE_BREAKPOINT,
        isNarrow: width <= NARROW_BREAKPOINT,
    }
}
