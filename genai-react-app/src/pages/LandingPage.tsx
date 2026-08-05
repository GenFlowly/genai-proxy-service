import React, { useEffect } from 'react'
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

function LandingPageContent() {
    // Current Chat Page uses the 'CHAT_PAGE' config
    // In future, you could dynamically pick config based on 'useConversation' or 'routeId'
    usePageTitle()
    const config = getPageConfig('CHAT_PAGE')
    const { isHistoryWidgetExpanded } = useLayout()

    return (
        <div className={styles.layout}>
            {isHistoryWidgetExpanded && config.pageId === 'CHAT_PAGE' && (
                <div className={styles.historySidebar}>
                    <ConversationHistoryComponent />
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

    // Orchestrate Sidebar and History states based on active conversation
    useEffect(() => {
        if (contextId) {
            // Active conversation: both collapsed, history hidden
            setRightSidebarExpanded(false)
            setLeftSidebarMinimized(false)
            setLeftSidebarExpanded(false)
            setHistoryWidgetExpanded(false)
        } else {
            // No conversation (New Chat): right expanded, left fully minimized/hidden, history expanded
            setRightSidebarExpanded(true)
            setLeftSidebarMinimized(true)
            setLeftSidebarExpanded(false)
            setHistoryWidgetExpanded(true)
        }
    }, [contextId, setRightSidebarExpanded, setLeftSidebarExpanded, setLeftSidebarMinimized, setHistoryWidgetExpanded])

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
