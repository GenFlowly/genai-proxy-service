import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import Navbar from '../components/navbar/Navbar'
import LeftSidebar from '../components/sections/LeftSidebar/LeftSidebar'
import ConversationHistoryComponent from '../components/widgets/ConversationHistoryWidget/ConversationHistoryComponent'
import ConversationHeader from '../components/widgets/ConversationHeader/ConversationHeader'
import RightSidebar from '../components/sections/RightSidebar/RightSidebar'
import CenterSection from '../components/sections/CenterSection/CenterSection'
import { useConversation } from '../context/ConversationContext'
import styles from './LandingPage.module.scss'
import { useLayout } from '../context/LayoutContext'

import { getPageConfig } from '../config/PageWidgetConfig'
import { usePageTitle } from '../hooks/usePageTitle'
import { useWindowSize } from '../hooks/useWindowSize'

// Resize bounds for the conversation-history panel (px)
const HISTORY_MIN_WIDTH = 160 // matches the panel's default 10rem
const HISTORY_MAX_WIDTH = 480

function LandingPageContent() {
    // Current Chat Page uses the 'CHAT_PAGE' config
    // In future, you could dynamically pick config based on 'useConversation' or 'routeId'
    usePageTitle()
    const config = getPageConfig('CHAT_PAGE')
    const { isHistoryWidgetExpanded } = useLayout()
    const { width } = useWindowSize()
    const isMobile = width <= 768

    // Width survives toggling because the state lives here, not on the panel
    const [historyWidth, setHistoryWidth] = useState(HISTORY_MIN_WIDTH)
    const historyRef = useRef<HTMLDivElement>(null)

    const handleHistoryResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        const startX = e.clientX
        const startWidth = historyRef.current?.offsetWidth ?? historyWidth
        const handle = e.currentTarget
        handle.setPointerCapture?.(e.pointerId)

        const onPointerMove = (ev: PointerEvent) => {
            const next = Math.min(HISTORY_MAX_WIDTH, Math.max(HISTORY_MIN_WIDTH, startWidth + (ev.clientX - startX)))
            setHistoryWidth(next)
        }
        const onPointerEnd = () => {
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerEnd)
            window.removeEventListener('pointercancel', onPointerEnd)
        }
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerEnd)
        window.addEventListener('pointercancel', onPointerEnd)
    }, [historyWidth])

    return (
        <div className={styles.layout}>
            {/* On mobile, history is a dedicated page (/history) instead of a sidebar widget */}
            {!isMobile && isHistoryWidgetExpanded && config.pageId === 'CHAT_PAGE' && (
                <div
                    className={styles.historySidebar}
                    ref={historyRef}
                    style={{ width: historyWidth }}
                    data-testid="history-sidebar"
                >
                    <ConversationHistoryComponent />
                    <div
                        className={styles.historyResizeHandle}
                        onPointerDown={handleHistoryResizeStart}
                        data-testid="history-resize-handle"
                    />
                </div>
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
            <Navbar />
            <ConversationHeader />
            <LandingPageContent />
        </div>
    )
}
