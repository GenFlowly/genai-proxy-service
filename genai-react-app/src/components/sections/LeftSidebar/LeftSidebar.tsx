import React from 'react'
import styles from './LeftSidebar.module.scss'

export default function LeftSidebar(): React.ReactElement {
    return (
        <aside className={styles.sidebar}>
            <div className={styles.section}>
                <h3 className={styles.title}>Projects</h3>
                <ul className={styles.list}>
                    <li>Default Project</li>
                    <li>Client Work</li>
                    <li>Personal Notes</li>
                </ul>
            </div>

            <div className={styles.section}>
                <h3 className={styles.title}>Quick Actions</h3>
                <button className={styles.actionButton}>New Project</button>
                <button className={styles.actionButton}>Import Prompt</button>
            </div>

            <div className={styles.section}>
                <h3 className={styles.title}>History</h3>
                <ul className={styles.list}>
                    <li>“Generate Landing Page”</li>
                    <li>“Explain AWS CDK”</li>
                    <li>“KMS Encrypt Example”</li>
                </ul>
            </div>
        </aside>
    )
}
