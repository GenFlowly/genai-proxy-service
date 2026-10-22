import React, { useEffect, useState } from 'react'
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

/** Settings key for the hard per-message search cap. Name, bounds and the
 * default must stay in sync with the proxy's CustomerCredentialsService
 * validation and the retrieval-server's tool_executor. */
const MAX_SEARCHES_SETTING = 'max_searches_per_turn'
const MAX_SEARCHES_DEFAULT = 5
const MAX_SEARCHES_MIN = 1
const MAX_SEARCHES_MAX = 20

interface WebSearchToolSettingsProps {
    /** Whether a key is currently stored for WEB_SEARCH. */
    connected: boolean
    /** Stored WEB_SEARCH settings, or null when the customer saved none. */
    settings?: Record<string, string> | null
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
    settings,
    getAccessTokenSilently,
    onChanged,
}: WebSearchToolSettingsProps): React.ReactElement {
    const { t } = useTranslation()
    const [keyInput, setKeyInput] = useState('')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState<string | null>(null)
    const [messageKind, setMessageKind] = useState<'success' | 'error' | null>(null)

    const storedLimit = parseStoredLimit(settings)
    const [limitInput, setLimitInput] = useState(String(storedLimit))
    // Statuses load after mount — refresh the field whenever the stored value
    // arrives or changes (a save calls onChanged, which reloads statuses).
    useEffect(() => { setLimitInput(String(storedLimit)) }, [storedLimit])

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

    const limitValue = parseLimitInput(limitInput)
    const limitDirty = limitValue !== null && limitValue !== storedLimit

    const handleSaveLimit = async () => {
        if (limitValue === null) {
            setMessage(t('settingsPage.toolsSettings.builtInSearchLimitInvalidToast'))
            setMessageKind('error')
            return
        }
        setBusy(true)
        setMessage(null)
        setMessageKind(null)
        try {
            const token = await getAccessTokenSilently()
            // Settings-only save: stored credentials are left untouched, and
            // the limit works even for customers on the platform search key.
            await storeToolCredentials(token, {
                toolType: WEB_SEARCH_TOOL_TYPE,
                authType: AUTH_TYPE,
                settings: { [MAX_SEARCHES_SETTING]: String(limitValue) },
            })
            setMessage(t('settingsPage.toolsSettings.builtInSearchLimitSavedToast'))
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
            <div className={styles.limitBlock}>
                <p className={styles.description}>
                    {t('settingsPage.toolsSettings.builtInSearchLimitLabel')}
                    {' — '}
                    {t('settingsPage.toolsSettings.builtInSearchLimitDescription')}
                </p>
                <div className={styles.keyRow}>
                    <InputTextWithHint
                        hint={t('settingsPage.toolsSettings.builtInSearchLimitHint')}
                        type="number"
                        value={limitInput}
                        disabled={busy}
                        onChange={e => setLimitInput(e.target.value)}
                        className={styles.limitInput}
                        data-testid="web-search-limit-input"
                    />
                    <PillButton
                        label={busy ? t('settingsPage.toolsSettings.savingLabel') : t('settingsPage.toolsSettings.builtInSearchLimitSave')}
                        icon={ICONS.SAVE_ICON}
                        disabled={busy || !limitDirty}
                        onClick={() => void handleSaveLimit()}
                        data-testid="web-search-limit-save"
                    />
                </div>
            </div>
        </CredentialCard>
    )
}

/** The stored hard cap, falling back to the platform default of 5. */
function parseStoredLimit(settings?: Record<string, string> | null): number {
    const parsed = parseLimitInput(settings?.[MAX_SEARCHES_SETTING] ?? '')
    return parsed ?? MAX_SEARCHES_DEFAULT
}

/** A valid in-bounds whole number, or null. */
function parseLimitInput(raw: string): number | null {
    if (!/^\d+$/.test(raw.trim())) return null
    const n = Number(raw.trim())
    return n >= MAX_SEARCHES_MIN && n <= MAX_SEARCHES_MAX ? n : null
}
