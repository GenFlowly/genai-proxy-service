import React from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { SettingsCard } from '@genflowly/component-library'
import styles from './UsageNotTrackedYet.module.scss'

interface UsageNotTrackedYetProps {
    /** A related page, e.g. the Vector DB Connection. */
    link?: { to: string; label: string }
    'data-testid'?: string
}

/**
 * The card a Cost and Usage page shows while its category isn't tracked yet
 * (its usage route answers 404), so the page reads as "coming", not broken.
 */
export function UsageNotTrackedYet({ link, 'data-testid': testId }: UsageNotTrackedYetProps): React.ReactElement {
    const { t } = useTranslation()
    return (
        <SettingsCard aria-label={t('settingsPage.usageCommon.notTrackedYetTitle')} data-testid={testId}>
            <div className={styles.body}>
                <p className={styles.title}>{t('settingsPage.usageCommon.notTrackedYetTitle')}</p>
                <p className={styles.text}>{t('settingsPage.usageCommon.notTrackedYetBody')}</p>
                {link && <Link to={link.to} className={styles.link}>{link.label}</Link>}
            </div>
        </SettingsCard>
    )
}
