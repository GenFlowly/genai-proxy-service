import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, PillButton, SettingsCard, SettingsRow, TypedConfirmDialog } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { DELETE_ACCOUNT_CONFIRMATION, deleteAccount, deleteAllCredentials } from '../../../services/accountService'
import { deleteAllMemoryFacts } from '../../../services/learnedFactsService'
import { deleteIndexedChats } from '../../../services/chatIndexingService'
import { useHasOwnKeys } from '../../../hooks/useHasOwnKeys'
import { SettingsFrame } from './SettingsFrame'
import { useSettingsShell } from '../SettingsShellContext'
import styles from './DeleteDataSettings.module.scss'

type Dialog = 'facts' | 'index' | 'keys' | 'account' | null

/**
 * Profile › Delete your data: every delete in Settings lives here — learned
 * facts, indexed chats, keys and connections (own-key customers only), and
 * the account. Each asks first; the account needs DELETE typed and signs the
 * user out once deletion has started. Deleting clears our servers only.
 */
export function DeleteDataSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently, logout, resyncAccount } = useAuth()
    const { showToast } = useToast()
    const { narrow } = useSettingsShell()
    const hasOwnKeys = useHasOwnKeys()
    const [dialog, setDialog] = useState<Dialog>(null)
    const [busy, setBusy] = useState(false)
    const [dialogError, setDialogError] = useState<string | null>(null)

    const open = (next: Dialog) => {
        setDialog(next)
        setDialogError(null)
    }
    const close = () => {
        if (!busy) setDialog(null)
    }

    /** Runs a delete; on success closes the dialog and shows its toast. */
    const run = async (action: (token: string) => Promise<string>, errorKey: string) => {
        if (!isAuthenticated) {
            setDialogError(t('settingsPage.profileSettings.deleteData.loginFirst'))
            return
        }
        setBusy(true)
        try {
            const message = await action(await getAccessTokenSilently())
            setDialog(null)
            showToast(message)
        } catch (error) {
            console.error('Delete failed', error)
            setDialogError(t(errorKey))
        } finally {
            setBusy(false)
        }
    }

    const deleteFacts = () => run(async token => {
        const count = await deleteAllMemoryFacts(token)
        return t('settingsPage.learnedFacts.deletedToast', { count })
    }, 'settingsPage.learnedFacts.deleteErrorToast')

    const deleteIndex = () => run(async token => {
        await deleteIndexedChats(token)
        return t('settingsPage.chatIndexing.deletedToast')
    }, 'settingsPage.chatIndexing.deleteErrorToast')

    const deleteKeys = () => run(async token => {
        const count = await deleteAllCredentials(token)
        resyncAccount()
        return count > 0
            ? t('settingsPage.profileSettings.deleteData.keysDeleted', { count })
            : t('settingsPage.profileSettings.deleteData.keysDeletedNone')
    }, 'settingsPage.profileSettings.deleteData.keysError')

    const handleDeleteAccount = async () => {
        if (!isAuthenticated) {
            setDialogError(t('settingsPage.profileSettings.deleteData.loginFirst'))
            return
        }
        setBusy(true)
        try {
            await deleteAccount(await getAccessTokenSilently())
            logout({ returnTo: window.location.origin })
        } catch (error) {
            console.error('Failed to delete the account', error)
            setDialogError(t('settingsPage.profileSettings.deleteData.accountError'))
            setBusy(false)
        }
    }

    const knowledge = [
        ...(hasOwnKeys ? [{ title: t('settingsPage.deleteData.keysTitle'), text: t('settingsPage.deleteData.keysText') }] : []),
        { title: t('settingsPage.deleteData.accountTitle'), text: t('settingsPage.deleteData.accountText') },
        ...(hasOwnKeys ? [{ title: t('settingsPage.deleteData.providersTitle'), text: t('settingsPage.deleteData.providersText') }] : []),
    ]
    const size = narrow ? 'lg' : 'md'

    const confirmDialog = (kind: Exclude<Dialog, 'account' | null>, title: string, body: string, confirmLabel: string, onConfirm: () => void) => (
        <Modal isOpen={dialog === kind} onClose={close} title={title} maxWidth="28rem">
            <p className={styles.dialogText}>{body}</p>
            {dialogError && <p className={styles.dialogError} role="alert">{dialogError}</p>}
            <div className={styles.dialogActions}>
                <PillButton label={t('settingsPage.profileSettings.deleteData.cancel')} variant="secondary" onClick={close} disabled={busy} />
                <PillButton
                    label={busy ? t('settingsPage.profileSettings.deleteData.deleting') : confirmLabel}
                    variant="danger"
                    onClick={onConfirm}
                    disabled={busy}
                    data-testid={`delete-${kind}-confirm`}
                />
            </div>
        </Modal>
    )

    return (
        <SettingsFrame page="delete" knowledge={knowledge}>
            <SettingsCard title={t('settingsPage.deleteData.factsCard')}>
                <SettingsRow
                    label={t('settingsPage.deleteData.factsRow')}
                    description={t('settingsPage.deleteData.factsText')}
                    action={<PillButton label={t('settingsPage.deleteData.factsButton')} variant="danger" size={size} onClick={() => open('facts')} data-testid="delete-facts-button" />}
                />
            </SettingsCard>
            <SettingsCard title={t('settingsPage.deleteData.indexCard')}>
                <SettingsRow
                    label={t('settingsPage.deleteData.indexRow')}
                    description={t('settingsPage.deleteData.indexText')}
                    action={<PillButton label={t('settingsPage.deleteData.indexButton')} variant="danger" size={size} onClick={() => open('index')} data-testid="delete-index-button" />}
                />
            </SettingsCard>
            {hasOwnKeys && (
                <SettingsCard title={t('settingsPage.deleteData.keysCard')}>
                    <SettingsRow
                        label={t('settingsPage.deleteData.keysRow')}
                        description={t('settingsPage.deleteData.keysRowText')}
                        action={<PillButton label={t('settingsPage.deleteData.keysButton')} variant="danger" size={size} onClick={() => open('keys')} data-testid="delete-keys-button" />}
                    />
                </SettingsCard>
            )}
            <SettingsCard title={t('settingsPage.deleteData.accountCard')} danger>
                <SettingsRow
                    label={t('settingsPage.deleteData.accountRow')}
                    description={t('settingsPage.deleteData.accountIntro')}
                    action={<PillButton label={t('settingsPage.deleteData.accountButton')} variant="danger" size={size} onClick={() => open('account')} data-testid="delete-account-button" />}
                >
                    <ul>
                        <li>{t('settingsPage.deleteData.accountConversations')}</li>
                        <li>{t('settingsPage.deleteData.accountContent')}</li>
                        {hasOwnKeys && <li>{t('settingsPage.deleteData.accountKeys')}</li>}
                        {hasOwnKeys && <li>{t('settingsPage.deleteData.accountVectors')}</li>}
                    </ul>
                </SettingsRow>
            </SettingsCard>

            {confirmDialog('facts', t('settingsPage.learnedFacts.deleteAllTitle'), t('settingsPage.learnedFacts.deleteAllConfirm'), t('settingsPage.learnedFacts.deleteAllConfirmButton'), deleteFacts)}
            {confirmDialog('index', t('settingsPage.chatIndexing.deleteTitle'), t('settingsPage.chatIndexing.deleteConfirm'), t('settingsPage.chatIndexing.deleteConfirmButton'), deleteIndex)}
            {confirmDialog('keys', t('settingsPage.profileSettings.deleteData.keysConfirmTitle'), t('settingsPage.profileSettings.deleteData.keysConfirmBody'), t('settingsPage.profileSettings.deleteData.keysConfirmButton'), deleteKeys)}

            <TypedConfirmDialog
                isOpen={dialog === 'account'}
                onClose={close}
                onConfirm={handleDeleteAccount}
                title={t('settingsPage.profileSettings.deleteData.accountConfirmTitle')}
                message={
                    <>
                        <p>{t('settingsPage.deleteData.accountIntro')}</p>
                        <ul>
                            <li>{t('settingsPage.deleteData.accountConversations')}</li>
                            <li>{t('settingsPage.deleteData.accountContent')}</li>
                            {hasOwnKeys && <li>{t('settingsPage.deleteData.accountKeys')}</li>}
                            {hasOwnKeys && <li>{t('settingsPage.deleteData.accountVectors')}</li>}
                        </ul>
                        {dialogError && <p className={styles.dialogError} role="alert">{dialogError}</p>}
                    </>
                }
                confirmWord={DELETE_ACCOUNT_CONFIRMATION}
                inputLabel={t('settingsPage.profileSettings.deleteData.accountConfirmPrompt', { word: DELETE_ACCOUNT_CONFIRMATION })}
                confirmLabel={busy ? t('settingsPage.profileSettings.deleteData.deleting') : t('settingsPage.profileSettings.deleteData.accountConfirmButton')}
                cancelLabel={t('settingsPage.profileSettings.deleteData.cancel')}
                busy={busy}
                data-testid="delete-account-dialog"
            />
        </SettingsFrame>
    )
}
