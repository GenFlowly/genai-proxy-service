import React from 'react'
import { RectangleButton } from '@genflowly/component-library'
import { useServiceWorkerUpdate } from '../../../hooks/useServiceWorkerUpdate'
import { APP_NAME } from '../../../constants/appName'
import styles from './ServiceWorkerUpdateNotifier.module.scss'

/** Banner prompting the user to apply an already-downloaded app update. */
export default function ServiceWorkerUpdateNotifier(): React.ReactElement | null {
    const { updateAvailable, applyUpdate } = useServiceWorkerUpdate()

    if (!updateAvailable) return null

    return (
        <div className={styles.banner} role="status" data-testid="sw-update-banner">
            <span>A new version of {APP_NAME} is available.</span>
            <RectangleButton label="Refresh" onClick={applyUpdate} data-testid="sw-update-refresh" />
        </div>
    )
}
