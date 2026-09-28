import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CredentialCard, CredentialStatusPill, InputTextWithHint, PillButton } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { deleteToolCredentials, storeToolCredentials } from '../../../services/customerToolsService'
import styles from './WebSearchToolSettings.module.scss'

/** SK in CustomerToolCredentials — must match WebSearchTool.credential_ref
 * in the retrieval-server (graph_tools/tools/web_search.py). */
const WEB_SEARCH_TOOL_TYPE = 'WEB_SEARCH'

/** Credentials stored from this card are a plain secret value, not OAuth. */
const AUTH_TYPE = 'api_key'

interface WebSearchToolSettingsProps {
    /** Whether a key is currently stored for WEB_SEARCH. */
    connected: boolean
    getAccessTokenSilently: () => Promise<string>
    /** Called after a successful save/remove so the caller can refresh status. */
    onChanged: () => void | Promise<void>
}

/**
 * Credential card for the built-in web_search tool (Tavily-backed). Unlike
 * customer-defined tools, this credential has nowhere else to be configured —
 * web_search is a reserved name a customer can never create a CustomerTools
 * row for — so it gets its own small section rather than living in the
 * generic tool-credential form.
 */
export function WebSearchToolSettings({
    connected,
    getAccessTokenSilently,
    onChanged,
}: WebSearchToolSettingsProps): React.ReactElement {
    const { t } = useTranslation()
    const [keyInput, setKeyInput] = useState('')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState<string | null>(null)
    const [messageKind, setMessageKind] = useState<'success' | 'error' | null>(null)

    const errorMessage = (error: unknown): string => (
        error instanceof Error && error.message
            ? error.message
            : t('settingsPage.toolsSettings.builtInGenericError')
    )

    const handleSave = async () => {
        const key = keyInput.trim()
        if (!key) {
            setMessage(t('settingsPage.toolsSettings.builtInKeyEmptyToast'))
            setMessageKind('error')
            return
        }
        setBusy(true)
        setMessage(null)
        setMessageKind(null)
        try {
            const token = await getAccessTokenSilently()
            await storeToolCredentials(token, {
                toolType: WEB_SEARCH_TOOL_TYPE,
                authType: AUTH_TYPE,
                credentials: { api_key: key },
            })
            setKeyInput('')
            setMessage(t('settingsPage.toolsSettings.builtInKeySavedToast'))
            setMessageKind('success')
            await onChanged()
        } catch (error) {
            setMessage(errorMessage(error))
            setMessageKind('error')
        } finally {
            setBusy(false)
        }
    }

    const handleRemove = async () => {
        if (!window.confirm(t('settingsPage.toolsSettings.builtInRemoveConfirm'))) return
        setBusy(true)
        setMessage(null)
        setMessageKind(null)
        try {
            const token = await getAccessTokenSilently()
            await deleteToolCredentials(token, WEB_SEARCH_TOOL_TYPE)
            setMessage(t('settingsPage.toolsSettings.builtInKeyRemovedToast'))
            setMessageKind('success')
            await onChanged()
        } catch (error) {
            setMessage(errorMessage(error))
            setMessageKind('error')
        } finally {
            setBusy(false)
        }
    }

    return (
        <CredentialCard
            data-testid="web-search-credential"
            label={t('settingsPage.toolsSettings.builtInWebSearchLabel')}
            pills={
                <CredentialStatusPill
                    kind={connected ? 'ok' : 'unset'}
                    data-testid="web-search-credential-status-pill"
                >
                    {connected
                        ? t('settingsPage.toolsSettings.builtInKeySetPill')
                        : t('settingsPage.toolsSettings.builtInKeyNotSetPill')}
                </CredentialStatusPill>
            }
            message={message}
            messageKind={messageKind}
        >
            <p className={styles.description}>{t('settingsPage.toolsSettings.builtInWebSearchDescription')}</p>
            <div className={styles.keyRow}>
                <InputTextWithHint
                    hint={t('settingsPage.toolsSettings.builtInKeyHint')}
                    type="password"
                    placeholder={connected
                        ? t('settingsPage.toolsSettings.builtInKeyReplacePlaceholder')
                        : t('settingsPage.toolsSettings.builtInKeyPlaceholder')}
                    value={keyInput}
                    disabled={busy}
                    onChange={e => setKeyInput(e.target.value)}
                    className={styles.keyInput}
                    data-testid="web-search-credential-key-input"
                />
                <PillButton
                    label={busy ? t('settingsPage.toolsSettings.savingLabel') : t('settingsPage.toolsSettings.builtInSaveKey')}
                    icon={ICONS.SAVE_ICON}
                    disabled={busy || !keyInput.trim()}
                    onClick={() => void handleSave()}
                    data-testid="web-search-credential-save"
                />
                {connected && (
                    <PillButton
                        label={t('settingsPage.toolsSettings.builtInRemoveKey')}
                        variant="danger"
                        disabled={busy}
                        onClick={() => void handleRemove()}
                        data-testid="web-search-credential-remove"
                    />
                )}
            </div>
        </CredentialCard>
    )
}
