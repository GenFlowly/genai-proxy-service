import React from 'react'
import { useTranslation } from 'react-i18next'
import { Cpu, Database, Globe } from 'lucide-react'
import styles from './AiDataConsentRows.module.scss'

/** Where the customer's data goes, in generic terms: the backend can change vendors without a release. */
export function AiDataConsentRows(): React.ReactElement {
    const { t } = useTranslation()
    const rows = [
        { icon: Cpu, title: t('aiDataConsent.modelsTitle'), body: t('aiDataConsent.modelsBody') },
        { icon: Database, title: t('aiDataConsent.memoryTitle'), body: t('aiDataConsent.memoryBody') },
        { icon: Globe, title: t('aiDataConsent.webTitle'), body: t('aiDataConsent.webBody') },
    ]

    return (
        <div className={styles.card} data-testid="ai-data-consent-rows">
            {rows.map(({ icon: Icon, title, body }) => (
                <div key={title} className={styles.row}>
                    <div className={styles.icon}>
                        <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                    </div>
                    <div className={styles.text}>
                        <div className={styles.title}>{title}</div>
                        <div className={styles.body}>{body}</div>
                    </div>
                </div>
            ))}
        </div>
    )
}
