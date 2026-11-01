import React from 'react'
import DatabaseConnectionsSettingsWidget from '../../../components/widgets/DatabaseConnectionsSettingsWidget/DatabaseConnectionsSettingsWidget'
import styles from './VectorDBSettings.module.scss'

/**
 * Settings section for the customer's own vector DB (Zilliz) connection.
 * The form itself is the existing DatabaseConnectionsSettingsWidget,
 * reused here so the widget and the settings page never drift apart.
 */
export function VectorDBSettings(): React.ReactElement {
    return (
        <div className={styles.container}>
            <div className={styles.widgetWrapper}>
                <DatabaseConnectionsSettingsWidget />
            </div>
        </div>
    )
}
