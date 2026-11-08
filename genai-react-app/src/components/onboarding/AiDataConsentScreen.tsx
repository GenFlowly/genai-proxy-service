import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { AiDataConsentRows } from './AiDataConsentRows'
import styles from './AiDataConsentScreen.module.scss'

export interface AiDataConsentScreenProps {
    /** Records the agreement on the backend; rethrows on failure. */
    onAgree: () => Promise<void>
    onDecline: () => void
}

/**
 * Full-screen permission to share data with third-party AI services, shown in
 * place of the whole app (see the AppContent gate) until the customer agrees.
 * Declining signs out: without the sharing there is no app to fall back to.
 */
export function AiDataConsentScreen({ onAgree, onDecline }: AiDataConsentScreenProps): React.ReactElement {
    const { t } = useTranslation()
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const agree = async () => {
        setSaving(true)
        setError(null)
        try {
            await onAgree()
        } catch (err) {
            console.error('Failed to record AI data consent', err)
            setError(t('aiDataConsent.saveError'))
            setSaving(false)
        }
    }

    return (
        <div className={styles.overlay} data-testid="ai-data-consent-screen">
            <div className={styles.panel}>
                <div className={styles.header}>
                    <div className={styles.headerIcon}>
                        <ExternalLink size={22} strokeWidth={1.75} aria-hidden="true" />
                    </div>
                    <h1 className={styles.title}>{t('aiDataConsent.title')}</h1>
                    <p className={styles.intro}>{t('aiDataConsent.intro')}</p>
                </div>

                <AiDataConsentRows />

                <p className={styles.note}>
                    {t('aiDataConsent.note')}{' '}
                    <a
                        href="/privacy-policy"
                        target="_blank"
                        rel="noreferrer noopener"
                        className={styles.policyLink}
                        data-testid="ai-data-consent-policy"
                    >
                        {t('aiDataConsent.privacyPolicy')}
                    </a>
                </p>

                <div className={styles.actions}>
                    {error && (
                        <p className={styles.error} role="alert" data-testid="ai-data-consent-error">{error}</p>
                    )}
                    <button
                        type="button"
                        className={styles.agree}
                        onClick={() => void agree()}
                        disabled={saving}
                        data-testid="ai-data-consent-agree"
                    >
                        {t('aiDataConsent.agree')}
                    </button>
                    <button
                        type="button"
                        className={styles.decline}
                        onClick={onDecline}
                        disabled={saving}
                        data-testid="ai-data-consent-decline"
                    >
                        {t('aiDataConsent.decline')}
                    </button>
                </div>
            </div>
        </div>
    )
}
