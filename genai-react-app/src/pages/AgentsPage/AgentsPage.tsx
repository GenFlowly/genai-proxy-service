import React, { useEffect, useState } from 'react'
import Navbar from '../../components/navbar/Navbar'
import styles from './AgentsPage.module.scss'
import { useLayout } from '../../context/LayoutContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import CreateAgentPanel from './CreateAgentPanel/CreateAgentPanel'

type AgentsView = 'list' | 'create'

export default function AgentsPage() {
    const [view, setView] = useState<AgentsView>('list')
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    usePageTitle()

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    return (
        <div className={styles.page}>
            <Navbar />
            {view === 'create' ? (
                <CreateAgentPanel onBack={() => setView('list')} />
            ) : (
                <div className={styles.emptyState}>
                    <div className={styles.emptyContent}>
                        <div className={styles.emptyIcon}>🤖</div>
                        <h2 className={styles.emptyTitle}>No agents yet</h2>
                        <p className={styles.emptyDescription}>
                            Build custom AI agents with specialized tools, memory, and personalities.
                        </p>
                        <button
                            className={styles.createBtn}
                            onClick={() => setView('create')}
                            type="button"
                        >
                            + Create Agent
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
