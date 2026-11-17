import React, { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useAuth } from '../../../context/AuthContext'
import { useLayout } from '../../../context/LayoutContext'
import { MenuLocationState } from '../../../hooks/useAppMenu'
import { useResponsiveBreakpoints } from '../../../hooks/useResponsiveBreakpoints'
import { SlidePanel } from '../../common/SlidePanel/SlidePanel'
import { L1Menu } from './L1Menu'

/**
 * Acts on the menu requests in location state: shows the L1 Menu over the
 * current page and opens the L2 Menu of a page just arrived at. On phones it
 * also shows the L1 Menu that is the app's root, so leaving it slides it away.
 *
 * Must render after <Routes>. Pages collapse the left sidebar in a mount
 * effect, and sibling effects run in order, so this one has to run last.
 */
export const AppMenuOverlay: React.FC = () => {
    const location = useLocation()
    const navigate = useNavigate()
    const { isNarrow } = useResponsiveBreakpoints()
    const { isOnboarding } = useAuth()
    const { setLeftSidebarExpanded } = useLayout()

    const state = location.state as MenuLocationState | null
    const wantsL2Menu = !!state?.openMobileMenu
    const isHome = location.pathname === '/'

    useEffect(() => {
        if (wantsL2Menu) setLeftSidebarExpanded(true)
    }, [wantsL2Menu, setLeftSidebarExpanded])

    // The FTUE wizard may still replace this whole tree once the /onboard sync
    // settles, so the request has to stay in history until then. Deferred because
    // a page's <Navigate> redirect can fire in this same commit, and replacing with
    // this now-stale location would undo it; that redirect cancels the timer.
    useEffect(() => {
        if (!wantsL2Menu || isOnboarding) return
        const timer = setTimeout(() => navigate(location, { replace: true, state: null }))
        return () => clearTimeout(timer)
    }, [wantsL2Menu, isOnboarding, navigate, location])

    return (
        <SlidePanel layer="l1" open={isNarrow && (isHome || !!state?.appMenu)} appearInPlace={isHome}>
            <L1Menu />
        </SlidePanel>
    )
}
