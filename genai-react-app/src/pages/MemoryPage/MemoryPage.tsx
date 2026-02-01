import React from 'react'
import Navbar from '../../components/navbar/Navbar'
import LeftSidebar from '../../components/sections/LeftSidebar/LeftSidebar'
import RightSidebar from '../../components/sections/RightSidebar/RightSidebar'
import CenterSection from '../../components/sections/CenterSection/CenterSection'
import styles from './MemoryPage.module.scss'
import { getPageConfig } from '../../config/PageWidgetConfig'

export default function MemoryPage() {
    const config = getPageConfig('MEMORY_PAGE')

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.layout}>
                <LeftSidebar widgetIds={config.leftSidebar} />
                <CenterSection widgetIds={config.centerSection} />
                <RightSidebar widgetIds={config.rightSidebar} />
            </div>
        </div>
    )
}
