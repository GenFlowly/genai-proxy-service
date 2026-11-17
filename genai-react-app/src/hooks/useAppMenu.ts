import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router'

/**
 * Menu requests carried in location state. They live in history rather than
 * context so browser Back closes the L1 Menu, and so a request survives the
 * Auth0 redirect and the FTUE wizard, which unmounts the layout providers.
 */
export interface MenuLocationState {
    /** Show the L1 Menu over the current page. */
    appMenu?: boolean
    /** Open the L2 Menu of the page being navigated to. */
    openMobileMenu?: boolean
}

export const OPEN_L2_MENU_STATE: MenuLocationState = { openMobileMenu: true }

/** Opens the L1 Menu over the current page, which stays mounted underneath. */
export function useOpenAppMenu(): () => void {
    const navigate = useNavigate()
    const location = useLocation()

    return useCallback(() => {
        navigate(location, { state: { ...(location.state as MenuLocationState | null), appMenu: true } })
    }, [navigate, location])
}
