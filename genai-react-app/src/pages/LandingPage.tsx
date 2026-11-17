import React, { useEffect } from 'react'
import { useParams, useLocation } from 'react-router'
import Navbar from '../components/navbar/Navbar'
import ConversationHeader from '../components/widgets/ConversationHeader/ConversationHeader'
import CenterSection from '../components/sections/CenterSection/CenterSection'
import ChatSidebar from '../components/sections/ChatSidebar/ChatSidebar'
import AiSettingsDock from '../components/sections/AiSettingsDock/AiSettingsDock'
import { useConversation } from '../context/ConversationContext'
import styles from './LandingPage.module.scss'

import { getPageConfig } from '../config/PageWidgetConfig'
import { usePageTitle } from '../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../hooks/useResponsiveBreakpoints'

function LandingPageContent() {
    usePageTitle()
    const config = getPageConfig('CHAT_PAGE')
    const { isNarrow } = useResponsiveBreakpoints()

    // 📱 Full-screen conversation under the overlay header; Chats and
    // Projects live in the L2 Menu, AI settings in a modal
    if (isNarrow) {
        return (
            <div className={styles.layout}>
                <CenterSection widgetIds={config.centerSection} />
                <AiSettingsDock />
            </div>
        )
    }

    return (
        <div className={styles.layout}>
            <ChatSidebar />
            <main className={styles.main}>
                <ConversationHeader />
                <CenterSection widgetIds={config.centerSection} />
            </main>
            <AiSettingsDock />
        </div>
    )
}

export default function LandingPage() {
    const { conversationId: routeId } = useParams<{ conversationId: string }>()
    const { loadConversation, conversationId: contextId, resetConversation } = useConversation()
    const location = useLocation()
    const { isNarrow } = useResponsiveBreakpoints()

    // 📱 The app never scrolls the window (each page scrolls internally),
    // but iOS Safari force-scrolls the window when the keyboard opens, and
    // bfcache / history scroll restoration can hand this page that residual
    // offset on load. With .page fixed at 100svh, a nonzero window scroll
    // pushes the bottom strip — the docked prompt editor — off-screen. Pin
    // the window to 0 on load and on every pageshow, and keep the browser
    // from restoring a stale offset while this page owns the history entry.
    useEffect(() => {
        const pinWindowScroll = () => {
            if (window.scrollY !== 0) window.scrollTo(0, 0)
        }
        pinWindowScroll()
        const previousRestoration = window.history.scrollRestoration
        try {
            window.history.scrollRestoration = 'manual'
        } catch { /* older browsers: restoration stays 'auto' */ }
        window.addEventListener('pageshow', pinWindowScroll)
        return () => {
            window.removeEventListener('pageshow', pinWindowScroll)
            try {
                window.history.scrollRestoration = previousRestoration
            } catch { /* ignore */ }
        }
    }, [])

    useEffect(() => {
        if (routeId) {
            // If URL has ID but context doesn't match, load it
            if (routeId !== contextId) {
                // Prevent race condition: verify routeId matches current URL
                if (!location.pathname.includes(routeId)) return
                loadConversation(routeId)
            }
        } else {
            // If URL has NO ID (New Chat) but context has an ID, reset it
            // Only reset if we are explicitly on the /chat page (not during navigation transition)
            const isBaseChat = location.pathname === '/chat' || location.pathname === '/chat/'
            if (contextId && isBaseChat) {
                resetConversation()
            }
        }
    }, [routeId, contextId, loadConversation, resetConversation, location.pathname])

    return (
        <div className={styles.page}>
            {/* Below isNarrow: no navbar — ConversationHeader renders a transparent
                overlay (MobileHeader) over the full-screen content instead */}
            {!isNarrow && <Navbar />}
            {isNarrow && <ConversationHeader />}
            <LandingPageContent />
        </div>
    )
}
