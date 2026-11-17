import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { InputTextWithHint, Modal, PillButton, SettingsCard, SettingsRow, StatusPill } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { ICONS } from '../../../constants/icons'
import {
    deleteToolCredentials,
    getToolCredentialStatuses,
    storeToolCredentials,
    ToolCredentialStatus,
} from '../../../services/customerToolsService'
import { SettingsFrame } from './SettingsFrame'
import { useSettingsShell } from '../SettingsShellContext'
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

/**
 * BYOK Settings › Web Search API Key: the Tavily key the built-in web_search
 * tool runs on, and how many searches it may run per message.
 */
export function WebSearchToolSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    const { narrow } = useSettingsShell()
    const [status, setStatus] = useState<ToolCredentialStatus | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [keyInput, setKeyInput] = useState('')
    const [busy, setBusy] = useState(false)
    const [confirmRemove, setConfirmRemove] = useState(false)

    const connected = !!status?.connected
    const storedLimit = parseStoredLimit(status?.settings)
    const [limitInput, setLimitInput] = useState(String(storedLimit))
    useEffect(() => { setLimitInput(String(storedLimit)) }, [storedLimit])

    const load = useCallback(async () => {
        if (!isAuthenticated) return
        try {
            const response = await getToolCredentialStatuses(await getAccessTokenSilently())
            setStatus(response.toolCredentialStatuses.find(s => s.toolType === WEB_SEARCH_TOOL_TYPE) ?? null)
        } catch (error: any) {
            showToast(error?.message || t('settingsPage.toolsSettings.loadErrorToast'))
        } finally {
            setLoaded(true)
        }
    }, [isAuthenticated, getAccessTokenSilently, showToast, t])

    useEffect(() => { void load() }, [load])

    const errorMessage = (error: unknown): string => (
        error instanceof Error && error.message ? error.message : t('settingsPage.toolsSettings.builtInGenericError')
    )

    const store = async (request: Parameters<typeof storeToolCredentials>[1], doneKey: string) => {
        setBusy(true)
        try {
            await storeToolCredentials(await getAccessTokenSilently(), request)
            showToast(t(doneKey))
            await load()
            return true
        } catch (error) {
            showToast(errorMessage(error))
            return false
        } finally {
            setBusy(false)
        }
    }

    const saveKey = async () => {
        const key = keyInput.trim()
        if (!key) {
            showToast(t('settingsPage.toolsSettings.builtInKeyEmptyToast'))
            return
        }
        const saved = await store(
            { toolType: WEB_SEARCH_TOOL_TYPE, authType: AUTH_TYPE, credentials: { api_key: key } },
            'settingsPage.toolsSettings.builtInKeySavedToast'
        )
        if (saved) setKeyInput('')
    }

    const limitValue = parseLimitInput(limitInput)
    const limitDirty = limitValue !== null && limitValue !== storedLimit

    const saveLimit = async () => {
        if (limitValue === null) {
            showToast(t('settingsPage.toolsSettings.builtInSearchLimitInvalidToast'))
            return
        }
        await store(
            { toolType: WEB_SEARCH_TOOL_TYPE, authType: AUTH_TYPE, settings: { [MAX_SEARCHES_SETTING]: String(limitValue) } },
            'settingsPage.toolsSettings.builtInSearchLimitSavedToast'
        )
    }

    const removeKey = async () => {
        setBusy(true)
        try {
            await deleteToolCredentials(await getAccessTokenSilently(), WEB_SEARCH_TOOL_TYPE)
            showToast(t('settingsPage.toolsSettings.builtInKeyRemovedToast'))
            setConfirmRemove(false)
            await load()
        } catch (error) {
            showToast(errorMessage(error))
        } finally {
            setBusy(false)
        }
    }

    const knowledge = [
        { title: t('settingsPage.webSearchKey.forTitle'), text: t('settingsPage.webSearchKey.forText') },
        { title: t('settingsPage.webSearchKey.usageTitle'), text: t('settingsPage.webSearchKey.usageText') },
        { title: t('settingsPage.webSearchKey.whereTitle'), text: t('settingsPage.webSearchKey.whereText') },
    ]
    const pillText = connected ? t('settingsPage.toolsSettings.builtInKeySetPill') : t('settingsPage.toolsSettings.builtInKeyNotSetPill')
    const pill = (testId?: string) => loaded
        ? <StatusPill kind={connected ? 'ok' : 'unset'} data-testid={testId}>{pillText}</StatusPill>
        : undefined
    const layout = narrow ? 'stacked' : 'inline'
    const size = narrow ? 'lg' : 'md'

    return (
        <SettingsFrame page="byok-web-search" knowledge={knowledge} status={pill()} statusText={loaded ? pillText : undefined}>
            <SettingsCard title={t('settingsPage.toolsSettings.builtInWebSearchLabel')} pills={pill('web-search-credential-status-pill')} data-testid="web-search-credential">
                <div className={styles.row}>
                    <InputTextWithHint
                        hint={t('settingsPage.toolsSettings.builtInKeyHint')}
                        type="password"
                        placeholder={connected
                            ? t('settingsPage.toolsSettings.builtInKeyReplacePlaceholder')
                            : t('settingsPage.toolsSettings.builtInKeyPlaceholder')}
                        value={keyInput}
                        disabled={busy}
                        onChange={e => setKeyInput(e.target.value)}
                        layout={layout}
                        className={styles.field}
                        data-testid="web-search-credential-key-input"
                    />
                    <PillButton
                        label={busy ? t('settingsPage.toolsSettings.savingLabel') : t('settingsPage.toolsSettings.builtInSaveKey')}
                        icon={ICONS.SAVE_ICON}
                        disabled={busy || !keyInput.trim()}
                        onClick={() => void saveKey()}
                        size={size}
                        data-testid="web-search-credential-save"
                    />
                    {connected && (
                        <PillButton
                            label={t('settingsPage.toolsSettings.builtInRemoveKey')}
                            variant="secondary"
                            disabled={busy}
                            onClick={() => setConfirmRemove(true)}
                            size={size}
                            data-testid="web-search-credential-remove"
                        />
                    )}
                </div>
            </SettingsCard>
            <SettingsCard title={t('settingsPage.toolsSettings.builtInSearchLimitHint')} hint={t('settingsPage.webSearchKey.limitRange')}>
                <div className={styles.row}>
                    <InputTextWithHint
                        hint={t('settingsPage.toolsSettings.builtInSearchLimitHint')}
                        type="number"
                        value={limitInput}
                        disabled={busy}
                        onChange={e => setLimitInput(e.target.value)}
                        layout={layout}
                        className={styles.limitField}
                        data-testid="web-search-limit-input"
                    />
                    <PillButton
                        label={busy ? t('settingsPage.toolsSettings.savingLabel') : t('settingsPage.toolsSettings.builtInSearchLimitSave')}
                        icon={ICONS.SAVE_ICON}
                        disabled={busy || !limitDirty}
                        onClick={() => void saveLimit()}
                        size={size}
                        data-testid="web-search-limit-save"
                    />
                </div>
            </SettingsCard>
            <SettingsCard title={t('settingsPage.webSearchKey.related')}>
                <SettingsRow
                    label={t('settingsPage.webSearchKey.usageLink')}
                    stackOnNarrow={false}
                    action={<Link to="/settings/usage/web-search" className={styles.link}>{t('settingsPage.nav.usage')}</Link>}
                />
            </SettingsCard>

            <Modal isOpen={confirmRemove} onClose={() => !busy && setConfirmRemove(false)} title={t('settingsPage.webSearchKey.removeTitle')} maxWidth="28rem">
                <p className={styles.dialogText}>{t('settingsPage.toolsSettings.builtInRemoveConfirm')}</p>
                <div className={styles.dialogActions}>
                    <PillButton label={t('settingsPage.profileSettings.deleteData.cancel')} variant="secondary" onClick={() => setConfirmRemove(false)} disabled={busy} />
                    <PillButton label={t('settingsPage.toolsSettings.builtInRemoveKey')} variant="danger" onClick={() => void removeKey()} disabled={busy} data-testid="web-search-credential-remove-confirm" />
                </div>
            </Modal>
        </SettingsFrame>
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
