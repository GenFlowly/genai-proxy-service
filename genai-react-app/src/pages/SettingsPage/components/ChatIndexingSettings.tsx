import React, { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService'
import { deleteIndexedChats } from '../../../services/chatIndexingService'
import { getAiPreferences, subscribeAiPreferences } from '../../../stores/aiPreferencesStore'
import styles from './ChatIndexingSettings.module.scss'

type Dialog = 'turnOff' | 'delete'

/**
 * Settings > Defaults > Search index: whether new chats are indexed for
 * search, and "Delete indexed chats". Indexing stays off until the user turns
 * it on (an unset preference means off, matching the backend). Turning it off
 * asks whether to delete what is already indexed.
 */
export function ChatIndexingSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    const preferences = useSyncExternalStore(subscribeAiPreferences, getAiPreferences)
    const [saving, setSaving] = useState<boolean | null>(null)
    const [dialog, setDialog] = useState<Dialog | null>(null)
    const [working, setWorking] = useState(false)

    const isOn = saving ?? preferences?.indexChats === true

    const save = async (indexChats: boolean): Promise<boolean> => {
        setSaving(indexChats)
        try {
            const token = await getAccessTokenSilently()
            await saveAIConfigPreferences(token, { aiConfigPreferences: { indexChats } })
            return true
        } catch (error: any) {
            console.error('Failed to save the chat indexing setting:', error)
            showToast(error?.message || t('settingsPage.chatIndexing.saveErrorToast'))
            return false
        } finally {
            setSaving(null)
        }
    }

    const deleteIndexed = async (): Promise<boolean> => {
        try {
            const token = await getAccessTokenSilently()
            await deleteIndexedChats(token)
            showToast(t('settingsPage.chatIndexing.deletedToast'))
            return true
        } catch (error) {
            console.error('Failed to delete indexed chats:', error)
            showToast(t('settingsPage.chatIndexing.deleteErrorToast'))
            return false
        }
    }

    const handleToggle = (checked: boolean) => {
        if (!isAuthenticated) {
            showToast(t('settingsPage.chatIndexing.loginFirstToast'))
            return
        }
        if (checked) {
            void save(true)
        } else {
            setDialog('turnOff')
        }
    }

    const handleStop = async (alsoDelete: boolean) => {
        setWorking(true)
        try {
            if (!(await save(false))) return
            if (alsoDelete && !(await deleteIndexed())) return
            setDialog(null)
        } finally {
            setWorking(false)
        }
    }

    const handleDelete = async () => {
        setWorking(true)
        try {
            if (await deleteIndexed()) setDialog(null)
        } finally {
            setWorking(false)
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.chatIndexing.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.chatIndexing.subtitle')}</p>
            </div>
            <div className={styles.form}>
                <label className={styles.toggleGroup}>
                    <span className={styles.toggleLabel}>
                        <strong>{t('settingsPage.chatIndexing.indexChats')}</strong>
                        <span>{t('settingsPage.chatIndexing.indexChatsDescription')}</span>
                    </span>
                    <input
                        type="checkbox"
                        checked={isOn}
                        onChange={(e) => handleToggle(e.target.checked)}
                        disabled={saving !== null}
                        data-testid="chat-indexing-switch"
                    />
                </label>
                <div className={styles.footer}>
                    <PillButton
                        variant="danger"
                        label={t('settingsPage.chatIndexing.deleteIndexed')}
                        onClick={() => setDialog('delete')}
                    />
                </div>
            </div>
            <Modal
                isOpen={dialog === 'turnOff'}
                onClose={() => setDialog(null)}
                title={t('settingsPage.chatIndexing.turnOffTitle')}
                maxWidth="28rem"
            >
                <p className={styles.confirmText}>{t('settingsPage.chatIndexing.turnOffConfirm')}</p>
                <div className={styles.confirmActions}>
                    <PillButton
                        variant="secondary"
                        label={t('settingsPage.chatIndexing.cancel')}
                        onClick={() => setDialog(null)}
                        disabled={working}
                    />
                    <PillButton
                        variant="secondary"
                        label={t('settingsPage.chatIndexing.stopIndexing')}
                        onClick={() => handleStop(false)}
                        disabled={working}
                    />
                    <PillButton
                        variant="danger"
                        label={working ? t('settingsPage.chatIndexing.working') : t('settingsPage.chatIndexing.stopAndDelete')}
                        onClick={() => handleStop(true)}
                        disabled={working}
                    />
                </div>
            </Modal>
            <Modal
                isOpen={dialog === 'delete'}
                onClose={() => setDialog(null)}
                title={t('settingsPage.chatIndexing.deleteTitle')}
                maxWidth="26rem"
            >
                <p className={styles.confirmText}>{t('settingsPage.chatIndexing.deleteConfirm')}</p>
                <div className={styles.confirmActions}>
                    <PillButton
                        variant="secondary"
                        label={t('settingsPage.chatIndexing.cancel')}
                        onClick={() => setDialog(null)}
                        disabled={working}
                    />
                    <PillButton
                        variant="danger"
                        label={working ? t('settingsPage.chatIndexing.working') : t('settingsPage.chatIndexing.deleteConfirmButton')}
                        onClick={handleDelete}
                        disabled={working}
                    />
                </div>
            </Modal>
        </div>
    )
}
