import React, { useEffect } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import Navbar from '../components/navbar/Navbar'
import LeftSidebar from '../components/sections/LeftSidebar/LeftSidebar'
import ConversationHistoryComponent from '../components/widgets/ConversationHistoryWidget/ConversationHistoryComponent'
import ConversationHeader from '../components/widgets/ConversationHeader/ConversationHeader'
import RightSidebar from '../components/sections/RightSidebar/RightSidebar'
import CenterSection from '../components/sections/CenterSection/CenterSection'
import { ResizableSidebar } from '@genflowly/component-library'
import { useConversation } from '../context/ConversationContext'
import styles from './LandingPage.module.scss'
import { useLayout } from '../context/LayoutContext'

import { getPageConfig } from '../config/PageWidgetConfig'
import { usePageTitle } from '../hooks/usePageTitle'
import { useWindowSize } from '../hooks/useWindowSize'

// Persisted width is stored in rem so it stays relative to the root font size
const HISTORY_WIDTH_STORAGE_KEY = 'conversation_history_width_rem'

function LandingPageContent() {
    // Current Chat Page uses the 'CHAT_PAGE' config
    // In future, you could dynamically pick config based on 'useConversation' or 'routeId'
    usePageTitle()
    const config = getPageConfig('CHAT_PAGE')
    const { isHistoryWidgetExpanded } = useLayout()
    const { width } = useWindowSize()
    const isMobile = width <= 768

    return (
        <div className={styles.layout}>
            {/* On mobile, history is a dedicated page (/history) instead of a sidebar widget */}
            {!isMobile && isHistoryWidgetExpanded && config.pageId === 'CHAT_PAGE' && (
                <ResizableSidebar
                    storageKey={HISTORY_WIDTH_STORAGE_KEY}
                    // The split's two stacked cards are the visible panels;
                    // this column only owns the shared width
                    variant="plain"
                    data-testid="history-sidebar"
                    handleTestId="history-resize-handle"
                >
                    <ConversationHistoryComponent />
                </ResizableSidebar>
            )}
            <LeftSidebar widgetIds={config.leftSidebar} />
            <CenterSection widgetIds={config.centerSection} />
            <RightSidebar widgetIds={config.rightSidebar} />
        </div>
    )
}

export default function LandingPage() {
    const { conversationId: routeId } = useParams<{ conversationId: string }>()
    const { loadConversation, conversationId: contextId, resetConversation } = useConversation()
    const { 
        setLeftSidebarExpanded, 
        setRightSidebarExpanded, 
        setLeftSidebarMinimized, 
        setHistoryWidgetExpanded 
    } = useLayout()
    const location = useLocation()
    const { width } = useWindowSize()
    const isMobile = width <= 768

    // Orchestrate Sidebar and History states based on active conversation
    useEffect(() => {
        if (contextId) {
            // Active conversation: both sidebars collapsed. History is left
            // alone here — it auto-hides only when the text-generation API is
            // called (see generateResponses/generateResponsesStream)
            setRightSidebarExpanded(false)
            setLeftSidebarMinimized(false)
            setLeftSidebarExpanded(false)
        } else {
            // No conversation (New Chat): right expanded (desktop), left fully minimized/hidden, history expanded (desktop)
            setRightSidebarExpanded(!isMobile)
            setLeftSidebarMinimized(true)
            setLeftSidebarExpanded(false)
            setHistoryWidgetExpanded(!isMobile)
        }
    }, [contextId, setRightSidebarExpanded, setLeftSidebarExpanded, setLeftSidebarMinimized, setHistoryWidgetExpanded, isMobile])

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
            {/* 📱 Mobile: no navbar — ConversationHeader renders a transparent
                overlay (MobileHeader) over the full-screen content instead */}
            {!isMobile && <Navbar />}
            <ConversationHeader />
            <LandingPageContent />
        </div>
    )
}
