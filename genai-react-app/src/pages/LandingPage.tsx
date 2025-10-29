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
    const { isLeftVisible, isRightVisible } = useLayout()

    return (
        <div className={styles.layout}>
            {isLeftVisible && (
                <div className={styles.sidebarLeft}>
                    <LeftSidebar />
                </div>
            )}

            <ConversationProvider>
                <CenterSection />
            </ConversationProvider>

            {isRightVisible && (
                <div className={styles.sidebarRight}>
                    <RightSidebar />
                </div>
            )}
        </div>
    )
}

export default function LandingPage() {
    return (
        <div className={styles.page}>
            <Navbar />
            <AIProvider>
                <LayoutProvider>
                    <LandingPageContent />
                </LayoutProvider>
            </AIProvider>
        </div>
    )
}
