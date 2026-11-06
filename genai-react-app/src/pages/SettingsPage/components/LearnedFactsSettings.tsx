import React, { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import {
    SaveAIConfigPreferencesRequest,
    saveAIConfigPreferences,
} from '../../../services/saveAIConfigService'
import { deleteAllMemoryFacts } from '../../../services/learnedFactsService'
import { getAiPreferences, subscribeAiPreferences } from '../../../stores/aiPreferencesStore'
import styles from './LearnedFactsSettings.module.scss'

type MemorySwitch = 'memoryLearnFromChats' | 'memoryLearnFromNotes' | 'memoryUseInReplies'

const SWITCHES: { key: MemorySwitch; label: string; description: string }[] = [
    {
        key: 'memoryLearnFromChats',
        label: 'settingsPage.learnedFacts.fromChats',
        description: 'settingsPage.learnedFacts.fromChatsDescription',
    },
    {
        key: 'memoryUseInReplies',
        label: 'settingsPage.learnedFacts.useInReplies',
        description: 'settingsPage.learnedFacts.useInRepliesDescription',
    },
]

/**
 * Settings > Defaults > Learned facts: the memory switches and
 * "Delete all learned facts". A switch is on until the user turns it off
 * (an unset preference means on, matching the backend) and saves as soon as
 * it changes. The save service writes the preferences store, so after a
 * failed save the switch falls back to the stored value.
 */
export function LearnedFactsSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    const preferences = useSyncExternalStore(subscribeAiPreferences, getAiPreferences)
    const [pending, setPending] = useState<Partial<Record<MemorySwitch, boolean>>>({})
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [deleting, setDeleting] = useState(false)

    const isOn = (key: MemorySwitch) => pending[key] ?? (preferences?.[key] !== false)

    const handleToggle = async (key: MemorySwitch, checked: boolean) => {
        if (!isAuthenticated) {
            showToast(t('settingsPage.learnedFacts.loginFirstToast'))
            return
        }
        setPending(prev => ({ ...prev, [key]: checked }))
        try {
            const token = await getAccessTokenSilently()
            const update: SaveAIConfigPreferencesRequest['aiConfigPreferences'] = {}
            update[key] = checked
            await saveAIConfigPreferences(token, { aiConfigPreferences: update })
        } catch (error: any) {
            console.error('Failed to save memory setting:', error)
            showToast(error?.message || t('settingsPage.learnedFacts.saveErrorToast'))
        } finally {
            setPending(prev => {
                const next = { ...prev }
                delete next[key]
                return next
            })
        }
    }

    const handleDeleteAll = async () => {
        setDeleting(true)
        try {
            const token = await getAccessTokenSilently()
            const deleted = await deleteAllMemoryFacts(token)
            showToast(t('settingsPage.learnedFacts.deletedToast', { count: deleted }))
            setConfirmOpen(false)
        } catch (error: any) {
            console.error('Failed to delete learned facts:', error)
            showToast(t('settingsPage.learnedFacts.deleteErrorToast'))
        } finally {
            setDeleting(false)
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.learnedFacts.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.learnedFacts.subtitle')}</p>
            </div>
            <div className={styles.form}>
                {SWITCHES.map(({ key, label, description }) => (
                    <label key={key} className={styles.toggleGroup}>
                        <span className={styles.toggleLabel}>
                            <strong>{t(label)}</strong>
                            <span>{t(description)}</span>
                        </span>
                        <input
                            type="checkbox"
                            checked={isOn(key)}
                            onChange={(e) => handleToggle(key, e.target.checked)}
                            disabled={key in pending}
                            data-testid={`learned-facts-${key}`}
                        />
                    </label>
                ))}
                <div className={styles.footer}>
                    <PillButton
                        variant="danger"
                        label={t('settingsPage.learnedFacts.deleteAll')}
                        onClick={() => setConfirmOpen(true)}
                    />
                </div>
            </div>
            <Modal
                isOpen={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                title={t('settingsPage.learnedFacts.deleteAllTitle')}
                maxWidth="26rem"
            >
                <p className={styles.confirmText}>{t('settingsPage.learnedFacts.deleteAllConfirm')}</p>
                <div className={styles.confirmActions}>
                    <PillButton
                        variant="secondary"
                        label={t('settingsPage.learnedFacts.cancel')}
                        onClick={() => setConfirmOpen(false)}
                        disabled={deleting}
                    />
                    <PillButton
                        variant="danger"
                        label={
                            deleting
                                ? t('settingsPage.learnedFacts.deleting')
                                : t('settingsPage.learnedFacts.deleteAllConfirmButton')
                        }
                        onClick={handleDeleteAll}
                        disabled={deleting}
                    />
                </div>
            </Modal>
        </div>
    )
}
