import React, { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import Navbar from '../components/navbar/Navbar'
import LeftSidebar from '../components/sections/LeftSidebar/LeftSidebar'
import RightSidebar from '../components/sections/RightSidebar/RightSidebar'
import CenterSection from '../components/sections/CenterSection/CenterSection'
import { useLayout } from '../context/LayoutContext'
import { useConversation } from '../context/ConversationContext'
import styles from './LandingPage.module.scss'

function LandingPageContent() {
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()

    return (
        <div className={styles.layout}>
            <div
                className={`${styles.sidebarLeft} ${!isLeftSidebarExpanded ? styles.collapsed : ''
                    }`}
            >
                <LeftSidebar />
            </div>

            <CenterSection />

            <div
                className={`${styles.sidebarRight} ${!isRightSidebarExpanded ? styles.collapsed : ''
                    }`}
            >
                <RightSidebar />
            </div>
        </div>
    )
}

export default function LandingPage() {
    const { conversationId } = useParams<{ conversationId: string }>()
    const { loadConversation } = useConversation()

    useEffect(() => {
        if (conversationId) {
            loadConversation(conversationId)
        }
    }, [conversationId, loadConversation])

    return (
        <div className={styles.page}>
            <Navbar />
            <LandingPageContent />
        </div>
    )
}
