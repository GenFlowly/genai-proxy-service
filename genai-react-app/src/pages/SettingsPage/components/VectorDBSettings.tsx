import React from 'react'
import { useTranslation } from 'react-i18next'
import DatabaseConnectionsSettingsWidget from '../../../components/widgets/DatabaseConnectionsSettingsWidget/DatabaseConnectionsSettingsWidget'
import styles from './VectorDBSettings.module.scss'

/**
 * Settings section for the customer's own vector DB (Zilliz) connection.
 * The form itself is the existing DatabaseConnectionsSettingsWidget,
 * reused here so the widget and the settings page never drift apart.
 */
export function VectorDBSettings(): React.ReactElement {
    const { t } = useTranslation()

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.vectorDbSettings.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.vectorDbSettings.subtitle')}</p>
            </div>
            <div className={styles.widgetWrapper}>
                <DatabaseConnectionsSettingsWidget />
            </div>
        </div>
    )
}
