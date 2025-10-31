import React from 'react'
import { useAI } from '../../../context/AIContext'
import AIVendorWidget from '../../widgets/AIVendorWidget/AIVendorWidget'
import styles from './RightSidebar.module.scss'
import {useLayout} from "../../../context/LayoutContext";

export default function RightSidebar(): React.ReactElement {
    const { config, setTemperature, setMaxTokens, setTone, resetConfig } = useAI()
    const { isRightSidebarExpanded } = useLayout()
    const collapsed = !isRightSidebarExpanded

    return (
        <div className={styles.sidebar}>
            {!collapsed && <h3 className={styles.title}>AI Configuration</h3>}

            {/* Vendor selection area */}
            <div className={styles.section}>
                {!collapsed && <h4 className={styles.sectionTitle}>Vendors</h4>}
                <AIVendorWidget collapsed={collapsed} />
            </div>


        </div>
    )
}
