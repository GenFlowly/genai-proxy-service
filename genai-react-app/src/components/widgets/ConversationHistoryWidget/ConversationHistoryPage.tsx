import React from 'react'
import Navbar from '../../navbar/Navbar'
import ConversationHistoryComponent from './ConversationHistoryComponent'
import styles from './ConversationHistoryPage.module.scss'

/**
 * Full-page wrapper around ConversationHistoryComponent.
 * Used on mobile, where the history is opened as its own page from the
 * mobile menu instead of being overlaid on the conversation view.
 */
export default function ConversationHistoryPage() {
    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.pageContainer}>
                <ConversationHistoryComponent />
            </div>
        </div>
    )
}
