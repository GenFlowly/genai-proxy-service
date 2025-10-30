import React from 'react'
import Navbar from '../components/navbar/Navbar'
import LeftSidebar from '../components/sections/LeftSidebar/LeftSidebar'
import RightSidebar from '../components/sections/RightSidebar/RightSidebar'
import CenterSection from '../components/sections/CenterSection/CenterSection'
import {AIProvider} from '../context/AIContext'
import {ConversationProvider} from '../context/ConversationContext'
import {LayoutProvider, useLayout} from '../context/LayoutContext'
import styles from './LandingPage.module.scss'

function LandingPageContent() {
    const {isLeftVisible, isRightVisible} = useLayout()

    return (
        <div className={styles.layout}>
            <div
                className={`${styles.sidebarLeft} ${
                    !isLeftVisible ? styles.collapsed : ''
                }`}
            >
                <LeftSidebar/>
            </div>

            <ConversationProvider>
                <CenterSection/>
            </ConversationProvider>

            <div
                className={`${styles.sidebarRight} ${
                    !isRightVisible ? styles.collapsed : ''
                }`}
            >
                <RightSidebar/>
            </div>
        </div>
    )
}

export default function LandingPage() {
    return (
        <div className={styles.page}>
            <LayoutProvider>
                <Navbar/>
                <AIProvider>

                    <LandingPageContent/>

                </AIProvider>
            </LayoutProvider>
        </div>
    )
}
