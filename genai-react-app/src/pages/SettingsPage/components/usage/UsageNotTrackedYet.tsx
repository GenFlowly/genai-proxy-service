import React from 'react'
import { useTranslation } from 'react-i18next'
import styles from './UsageNotTrackedYet.module.scss'

interface UsageNotTrackedYetProps {
    'data-testid'?: string
}

/**
 * Shared empty state for the three Cost and Usage sub-pages whose backend
 * instrumentation hasn't shipped yet (Embedding, Vector DB, Web Search — see
 * UsageActivity.kt: those routes 404 until their phase lands). Rendered
 * instead of an error so the pages read as "coming soon," not broken.
 */
export function UsageNotTrackedYet({ 'data-testid': testId }: UsageNotTrackedYetProps): React.ReactElement {
    const { t } = useTranslation()

    return (
        <div className={styles.container} data-testid={testId}>
            <p className={styles.title}>{t('settingsPage.usageCommon.notTrackedYetTitle')}</p>
            <p className={styles.body}>{t('settingsPage.usageCommon.notTrackedYetBody')}</p>
        </div>
    )
}
