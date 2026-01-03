import React, { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import Navbar from '../components/navbar/Navbar'
import LeftSidebar from '../components/sections/LeftSidebar/LeftSidebar'
import RightSidebar from '../components/sections/RightSidebar/RightSidebar'
import CenterSection from '../components/sections/CenterSection/CenterSection'
import { useConversation } from '../context/ConversationContext'
import styles from './LandingPage.module.scss'

function LandingPageContent() {

    return (
        <div className={styles.layout}>
            <LeftSidebar />
            <CenterSection />
            <RightSidebar />
        </div>
    )
}

export default function LandingPage() {
    const { conversationId: routeId } = useParams<{ conversationId: string }>()
    const { loadConversation, conversationId: contextId, resetConversation } = useConversation()

    useEffect(() => {
        if (routeId) {
            // If URL has ID but context doesn't match, load it
            if (routeId !== contextId) {
                // Prevent race condition: verify routeId matches current URL
                if (!window.location.pathname.includes(routeId)) return
                loadConversation(routeId)
            }
        } else {
            // If URL has NO ID (New Chat) but context has an ID, reset it
            // Only reset if we are explicitly on the /chat page (not during navigation transition)
            const isBaseChat = window.location.pathname === '/chat' || window.location.pathname === '/chat/'
            if (contextId && isBaseChat) {
                resetConversation()
            }
        }
    }, [routeId, contextId, loadConversation, resetConversation])

    return (
        <div className={styles.page}>
            <Navbar />
            <LandingPageContent />
        </div>
    )
}
