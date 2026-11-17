import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    DataTable,
    DataTableColumn,
    InputTextWithHint,
    Modal,
    PillButton,
    SettingsCard,
    StatusPill,
    formatCompactCount,
} from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { useHasOwnKeys } from '../../../hooks/useHasOwnKeys'
import { ICONS } from '../../../constants/icons'
import {
    createDeveloperApiKey,
    listDeveloperApiKeys,
    revokeDeveloperApiKey,
} from '../../../services/developerApiKeysService'
import {
    DeveloperApiKeyCreatedResponse,
    DeveloperApiKeySummary,
    DeveloperApiKeyUsage,
} from '../../../models/developerApiKeys.models'
import { formatServerTimestamp } from '@genflowly/component-library'
import { formatUsd } from './usage/usageFormat'
import { SettingsFrame } from './SettingsFrame'
import { useSettingsShell } from '../SettingsShellContext'
import styles from './DeveloperSettings.module.scss'

const NO_VALUE = '—'

const formatDate = (iso?: string): string =>
    formatServerTimestamp(iso, { year: 'numeric', month: '2-digit', day: '2-digit' }) || NO_VALUE
const formatCost = (value?: number | null): string => (value == null ? NO_VALUE : formatUsd(value))
const formatRequests = (value?: number | null): string => (value == null ? NO_VALUE : formatCompactCount(value))

/**
 * Developer: API keys that let the customer's own apps call this app as
 * them. A new key is shown once, then only its prefix. Each key lists its
 * requests and cost for the last 30 days and all time, with an "All keys"
 * row; a dash means its usage couldn't be read.
 */
export function DeveloperSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { showToast } = useToast()
    const { narrow } = useSettingsShell()
    const hasOwnKeys = useHasOwnKeys()

    const [keys, setKeys] = useState<DeveloperApiKeySummary[]>([])
    const [totals, setTotals] = useState<DeveloperApiKeyUsage | undefined>()
    const [loadingList, setLoadingList] = useState(true)
    const [newKeyName, setNewKeyName] = useState('')
    const [creating, setCreating] = useState(false)
    const [revoking, setRevoking] = useState(false)
    const [keyToRevoke, setKeyToRevoke] = useState<DeveloperApiKeySummary | null>(null)
    const [createdKey, setCreatedKey] = useState<DeveloperApiKeyCreatedResponse | null>(null)

    const loadKeys = useCallback(async () => {
        if (!isAuthenticated || !customerId) return
        try {
            setLoadingList(true)
            const response = await listDeveloperApiKeys(await getAccessTokenSilently())
            setKeys(response.keys)
            setTotals(response.totals)
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.developerSettings.loadErrorToast'))
        } finally {
            setLoadingList(false)
        }
    }, [isAuthenticated, customerId, getAccessTokenSilently, showToast, t])

    useEffect(() => {
        void loadKeys()
    }, [loadKeys])

    const handleCreate = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('settingsPage.developerSettings.loginFirstToast'))
            return
        }
        const name = newKeyName.trim()
        if (!name) {
            showToast(t('settingsPage.developerSettings.enterKeyNameToast'))
            return
        }
        try {
            setCreating(true)
            const created = await createDeveloperApiKey(await getAccessTokenSilently(), { name })
            setCreatedKey(created)
            setNewKeyName('')
            await loadKeys()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.developerSettings.createErrorToast'))
        } finally {
            setCreating(false)
        }
    }

    const handleCopy = async () => {
        if (!createdKey) return
        try {
            await navigator.clipboard.writeText(createdKey.apiKey)
            showToast(t('settingsPage.developerSettings.copiedToast'))
        } catch {
            showToast(t('settingsPage.developerSettings.copyFailedToast'))
        }
    }

    const handleRevoke = async () => {
        if (!keyToRevoke) return
        try {
            setRevoking(true)
            await revokeDeveloperApiKey(await getAccessTokenSilently(), keyToRevoke.keyId)
            if (createdKey?.keyId === keyToRevoke.keyId) setCreatedKey(null)
            setKeyToRevoke(null)
            showToast(t('settingsPage.developerSettings.revokedToast'))
            await loadKeys()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.developerSettings.revokeErrorToast'))
        } finally {
            setRevoking(false)
        }
    }

    const costHeader = (period: '30d' | 'allTime') => hasOwnKeys
        ? t(period === '30d' ? 'settingsPage.developerSettings.estCost30d' : 'settingsPage.developerSettings.estCostAllTime')
        : t(period === '30d' ? 'settingsPage.developerSettings.cost30d' : 'settingsPage.developerSettings.costAllTime')

    const columns: DataTableColumn<DeveloperApiKeySummary>[] = [
        { key: 'name', header: t('settingsPage.developerSettings.name'), render: key => <span className={styles.keyName}>{key.name}</span> },
        { key: 'prefix', header: t('settingsPage.developerSettings.key'), render: key => <code className={styles.keyPrefix}>{key.prefix}…</code> },
        { key: 'created', header: t('settingsPage.developerSettings.created'), render: key => formatDate(key.createdAt) },
        { key: 'lastUsed', header: t('settingsPage.developerSettings.lastUsed'), render: key => formatDate(key.lastUsedAt) },
        { key: 'requests30d', header: t('settingsPage.developerSettings.requests30d'), numeric: true, render: key => formatRequests(key.requests30d) },
        { key: 'cost30d', header: costHeader('30d'), numeric: true, render: key => formatCost(key.costUsd30d) },
        { key: 'costAllTime', header: costHeader('allTime'), numeric: true, render: key => formatCost(key.costUsdAllTime) },
        {
            key: 'revoke',
            header: <span className={styles.srOnly}>{t('settingsPage.developerSettings.revoke')}</span>,
            render: key => (
                <PillButton
                    onClick={() => setKeyToRevoke(key)}
                    label={t('settingsPage.developerSettings.revoke')}
                    variant="danger"
                    size="sm"
                    disabled={revoking && keyToRevoke?.keyId === key.keyId}
                    data-testid={`revoke-key-${key.keyId}`}
                />
            ),
        },
    ]
    const footer = keys.length > 0 ? [
        t('settingsPage.developerSettings.allKeys'), '', '', '',
        formatRequests(totals?.requests30d),
        formatCost(totals?.costUsd30d),
        formatCost(totals?.costUsdAllTime),
        '',
    ] : undefined

    const keyCount = t('settingsPage.developerSettings.keyCount', { count: keys.length })
    const spent = totals?.costUsdAllTime != null
        ? t(hasOwnKeys ? 'settingsPage.developerSettings.spentEstimate' : 'settingsPage.developerSettings.spent', { cost: formatUsd(totals.costUsdAllTime) })
        : null
    const knowledge = [
        { title: t('settingsPage.developerSettings.whatTitle'), text: t('settingsPage.developerSettings.whatText') },
        { title: t('settingsPage.developerSettings.safeTitle'), text: t('settingsPage.developerSettings.safeText') },
        { title: t('settingsPage.developerSettings.costTitle'), text: t('settingsPage.developerSettings.costText') },
    ]
    const size = narrow ? 'lg' : 'md'

    return (
        <SettingsFrame
            page="developer"
            knowledge={knowledge}
            statusText={loadingList ? undefined : keyCount}
            status={loadingList ? undefined : (
                <>
                    <StatusPill>{keyCount}</StatusPill>
                    {spent && <StatusPill>{spent}</StatusPill>}
                </>
            )}
        >
            <SettingsCard title={t('settingsPage.developerSettings.createCard')}>
                <div className={styles.createRow}>
                    <InputTextWithHint
                        hint={t('settingsPage.developerSettings.keyNameHint')}
                        value={newKeyName}
                        onChange={e => setNewKeyName(e.target.value)}
                        placeholder={t('settingsPage.developerSettings.keyNamePlaceholder')}
                        layout={narrow ? 'stacked' : 'inline'}
                        className={styles.createField}
                        data-testid="api-key-name-input"
                    />
                    <PillButton
                        onClick={() => void handleCreate()}
                        label={creating ? t('settingsPage.developerSettings.creatingLabel') : t('settingsPage.developerSettings.createApiKey')}
                        icon={ICONS.PLUS}
                        disabled={creating}
                        size={size}
                        data-testid="create-api-key"
                    />
                </div>
            </SettingsCard>

            {createdKey && (
                <SettingsCard
                    title={t('settingsPage.developerSettings.createdKeyTitle', { name: createdKey.name })}
                    pills={<StatusPill kind="ok">{t('settingsPage.developerSettings.copyItNow')}</StatusPill>}
                    data-testid="created-key-panel"
                >
                    <p className={styles.createdKeyWarning}>{t('settingsPage.developerSettings.createdKeyWarning')}</p>
                    <div className={styles.createdKeyRow}>
                        <code className={styles.createdKeyValue} data-testid="created-key-value">{createdKey.apiKey}</code>
                        <PillButton onClick={() => void handleCopy()} label={t('settingsPage.developerSettings.copy')} icon={ICONS.COPY} variant="secondary" size={size} />
                    </div>
                    <div>
                        <PillButton onClick={() => setCreatedKey(null)} label={t('settingsPage.developerSettings.savedMyKey')} size={size} data-testid="created-key-dismiss" />
                    </div>
                </SettingsCard>
            )}

            <SettingsCard title={t('settingsPage.developerSettings.yourApiKeys')} flush>
                {loadingList ? (
                    <p className={styles.emptyState}>{t('settingsPage.developerSettings.loading')}</p>
                ) : (
                    <DataTable
                        columns={columns}
                        rows={keys}
                        rowKey={key => key.keyId}
                        footer={footer}
                        caption={t('settingsPage.developerSettings.yourApiKeys')}
                        emptyText={t('settingsPage.developerSettings.noKeysYet')}
                        data-testid="api-keys-table"
                    />
                )}
            </SettingsCard>

            <Modal
                isOpen={keyToRevoke != null}
                onClose={() => !revoking && setKeyToRevoke(null)}
                title={t('settingsPage.developerSettings.revokeTitle', { name: keyToRevoke?.name ?? '' })}
                maxWidth="28rem"
            >
                <p className={styles.dialogText}>{t('settingsPage.developerSettings.revokeText')}</p>
                <div className={styles.dialogActions}>
                    <PillButton label={t('settingsPage.profileSettings.deleteData.cancel')} variant="secondary" onClick={() => setKeyToRevoke(null)} disabled={revoking} />
                    <PillButton
                        label={revoking ? t('settingsPage.developerSettings.revokingLabel') : t('settingsPage.developerSettings.revoke')}
                        variant="danger"
                        onClick={() => void handleRevoke()}
                        disabled={revoking}
                        data-testid="revoke-key-confirm"
                    />
                </div>
            </Modal>
        </SettingsFrame>
    )
}
