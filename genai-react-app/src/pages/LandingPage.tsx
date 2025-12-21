import React from 'react'
import Navbar from '../components/navbar/Navbar'
import LeftSidebar from '../components/sections/LeftSidebar/LeftSidebar'
import RightSidebar from '../components/sections/RightSidebar/RightSidebar'
import CenterSection from '../components/sections/CenterSection/CenterSection'
import { AIProvider } from '../context/AIContext'
import { ConversationProvider } from '../context/ConversationContext'
import { LayoutProvider, useLayout } from '../context/LayoutContext'
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
    return (
        <div className={styles.page}>
            <Navbar />
            <LandingPageContent />
        </div>
    )
}
