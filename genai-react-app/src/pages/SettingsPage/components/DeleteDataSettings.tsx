import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import {
    DELETE_ACCOUNT_CONFIRMATION,
    deleteAccount,
    deleteAllCredentials,
} from '../../../services/accountService'
import styles from './DeleteDataSettings.module.scss'

type Dialog = 'keys' | 'account' | null

/**
 * The "Delete your data" section of Settings > Profile: delete every stored
 * API key, or the whole account. Each asks first; the account also needs the
 * typed confirmation, and signs the user out once deletion has started.
 */
export function DeleteDataSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently, logout, resyncAccount } = useAuth()
    const [dialog, setDialog] = useState<Dialog>(null)
    const [typed, setTyped] = useState('')
    const [busy, setBusy] = useState(false)
    const [dialogError, setDialogError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    const open = (next: Dialog) => {
        setDialog(next)
        setTyped('')
        setDialogError(null)
        setNotice(null)
    }

    const close = () => {
        if (!busy) setDialog(null)
    }

    const handleDeleteKeys = async () => {
        if (!isAuthenticated) {
            setDialogError(t('settingsPage.profileSettings.deleteData.loginFirst'))
            return
        }
        setBusy(true)
        try {
            const token = await getAccessTokenSilently()
            const count = await deleteAllCredentials(token)
            resyncAccount()
            setDialog(null)
            setNotice(
                count > 0
                    ? t('settingsPage.profileSettings.deleteData.keysDeleted', { count })
                    : t('settingsPage.profileSettings.deleteData.keysDeletedNone')
            )
        } catch (error) {
            console.error('Failed to delete keys', error)
            setDialogError(t('settingsPage.profileSettings.deleteData.keysError'))
        } finally {
            setBusy(false)
        }
    }

    const handleDeleteAccount = async () => {
        if (typed !== DELETE_ACCOUNT_CONFIRMATION) return
        if (!isAuthenticated) {
            setDialogError(t('settingsPage.profileSettings.deleteData.loginFirst'))
            return
        }
        setBusy(true)
        try {
            const token = await getAccessTokenSilently()
            await deleteAccount(token)
            logout({ returnTo: window.location.origin })
        } catch (error) {
            console.error('Failed to delete the account', error)
            setDialogError(t('settingsPage.profileSettings.deleteData.accountError'))
            setBusy(false)
        }
    }

    return (
        <div className={styles.section}>
            <h3 className={styles.sectionTitle}>{t('settingsPage.profileSettings.deleteData.title')}</h3>

            {notice && (
                <div className={styles.notice} role="status" data-testid="delete-data-notice">
                    {notice}
                </div>
            )}

            <div className={styles.row}>
                <div className={styles.rowText}>
                    <strong>{t('settingsPage.profileSettings.deleteData.keysTitle')}</strong>
                    <span>{t('settingsPage.profileSettings.deleteData.keysDescription')}</span>
                </div>
                <PillButton
                    label={t('settingsPage.profileSettings.deleteData.keysButton')}
                    variant="danger"
                    onClick={() => open('keys')}
                    data-testid="delete-keys-button"
                />
            </div>

            <div className={styles.row}>
                <div className={styles.rowText}>
                    <strong>{t('settingsPage.profileSettings.deleteData.accountTitle')}</strong>
                    <span>{t('settingsPage.profileSettings.deleteData.accountDescription')}</span>
                </div>
                <PillButton
                    label={t('settingsPage.profileSettings.deleteData.accountButton')}
                    variant="danger"
                    onClick={() => open('account')}
                    data-testid="delete-account-button"
                />
            </div>

            <Modal
                isOpen={dialog === 'keys'}
                onClose={close}
                title={t('settingsPage.profileSettings.deleteData.keysConfirmTitle')}
                maxWidth="28rem"
            >
                <p className={styles.dialogText}>{t('settingsPage.profileSettings.deleteData.keysConfirmBody')}</p>
                {dialogError && <p className={styles.dialogError} role="alert">{dialogError}</p>}
                <div className={styles.dialogActions}>
                    <PillButton
                        label={t('settingsPage.profileSettings.deleteData.cancel')}
                        variant="secondary"
                        onClick={close}
                        disabled={busy}
                    />
                    <PillButton
                        label={busy
                            ? t('settingsPage.profileSettings.deleteData.deleting')
                            : t('settingsPage.profileSettings.deleteData.keysConfirmButton')}
                        variant="danger"
                        onClick={handleDeleteKeys}
                        disabled={busy}
                        data-testid="delete-keys-confirm"
                    />
                </div>
            </Modal>

            <Modal
                isOpen={dialog === 'account'}
                onClose={close}
                title={t('settingsPage.profileSettings.deleteData.accountConfirmTitle')}
                maxWidth="32rem"
            >
                <p className={styles.dialogText}>{t('settingsPage.profileSettings.deleteData.accountConfirmIntro')}</p>
                <ul className={styles.dialogList}>
                    <li>{t('settingsPage.profileSettings.deleteData.accountConfirmConversations')}</li>
                    <li>{t('settingsPage.profileSettings.deleteData.accountConfirmContent')}</li>
                    <li>{t('settingsPage.profileSettings.deleteData.accountConfirmKeys')}</li>
                    <li>{t('settingsPage.profileSettings.deleteData.accountConfirmVectors')}</li>
                </ul>
                <p className={styles.dialogText}>{t('settingsPage.profileSettings.deleteData.accountConfirmKept')}</p>
                <p className={styles.dialogText}>
                    <strong>{t('settingsPage.profileSettings.deleteData.accountConfirmUndo')}</strong>
                </p>
                <label className={styles.confirmLabel} htmlFor="delete-account-confirmation">
                    {t('settingsPage.profileSettings.deleteData.accountConfirmPrompt', { word: DELETE_ACCOUNT_CONFIRMATION })}
                </label>
                <input
                    id="delete-account-confirmation"
                    className={styles.confirmInput}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    disabled={busy}
                    data-testid="delete-account-input"
                />
                {dialogError && <p className={styles.dialogError} role="alert">{dialogError}</p>}
                <div className={styles.dialogActions}>
                    <PillButton
                        label={t('settingsPage.profileSettings.deleteData.cancel')}
                        variant="secondary"
                        onClick={close}
                        disabled={busy}
                    />
                    <PillButton
                        label={busy
                            ? t('settingsPage.profileSettings.deleteData.deleting')
                            : t('settingsPage.profileSettings.deleteData.accountConfirmButton')}
                        variant="danger"
                        onClick={handleDeleteAccount}
                        disabled={busy || typed !== DELETE_ACCOUNT_CONFIRMATION}
                        data-testid="delete-account-confirm"
                    />
                </div>
            </Modal>
        </div>
    )
}
