import React, { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { config } from '../../../config/env'
import PillButton from '../../../components/common/PillButton/PillButton'
import { InputTextWithHint } from '../../../components/common/InputTextWithHint/InputTextWithHint'
import { ICONS } from '../../../constants/icons'
import {
    createDeveloperApiKey,
    listDeveloperApiKeys,
    revokeDeveloperApiKey,
} from '../../../services/developerApiKeysService'
import {
    DeveloperApiKeyCreatedResponse,
    DeveloperApiKeySummary,
} from '../../../models/developerApiKeys.models'
import styles from './DeveloperSettings.module.scss'

function formatDate(iso?: string): string {
    if (!iso) return '—'
    const date = new Date(iso)
    return isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

export function DeveloperSettings(): React.ReactElement {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()
    const { showToast } = useToast()

    const [keys, setKeys] = useState<DeveloperApiKeySummary[]>([])
    const [loadingList, setLoadingList] = useState(true)
    const [newKeyName, setNewKeyName] = useState('')
    const [creating, setCreating] = useState(false)
    const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null)
    // Freshly created key: the full value is only ever available here, right after creation
    const [createdKey, setCreatedKey] = useState<DeveloperApiKeyCreatedResponse | null>(null)

    const loadKeys = useCallback(async () => {
        if (!isAuthenticated || !customerId) return
        try {
            setLoadingList(true)
            const token = await getAccessTokenSilently()
            const response = await listDeveloperApiKeys(token)
            setKeys(response.keys)
        } catch (error: any) {
            console.error(error)
            showToast(error.message || 'Error loading API keys.')
        } finally {
            setLoadingList(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    useEffect(() => {
        loadKeys()
    }, [loadKeys])

    const handleCreate = async () => {
        if (!isAuthenticated || !customerId) {
            showToast('Please log in first.')
            return
        }
        const name = newKeyName.trim()
        if (!name) {
            showToast('Please enter a name for the key.')
            return
        }

        try {
            setCreating(true)
            const token = await getAccessTokenSilently()
            const created = await createDeveloperApiKey(token, { name })
            setCreatedKey(created)
            setNewKeyName('')
            await loadKeys()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || 'Error creating API key.')
        } finally {
            setCreating(false)
        }
    }

    const handleCopy = async () => {
        if (!createdKey) return
        try {
            await navigator.clipboard.writeText(createdKey.apiKey)
            showToast('API key copied to clipboard.')
        } catch {
            showToast('Could not copy — please select and copy the key manually.')
        }
    }

    const handleRevoke = async (key: DeveloperApiKeySummary) => {
        if (!window.confirm(`Revoke the key "${key.name}"? Applications using it will stop working immediately.`)) {
            return
        }
        try {
            setRevokingKeyId(key.keyId)
            const token = await getAccessTokenSilently()
            await revokeDeveloperApiKey(token, key.keyId)
            // The revoked key can no longer be the "just created" one worth showing
            if (createdKey?.keyId === key.keyId) setCreatedKey(null)
            showToast('API key revoked.')
            await loadKeys()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || 'Error revoking API key.')
        } finally {
            setRevokingKeyId(null)
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>Developer</h2>
                <p className={styles.subtitle}>
                    Create API keys to call the API from your own code instead of logging in.
                    Send a key on every request as{' '}
                    <code className={styles.inlineCode}>Authorization: Bearer gfy_...</code>
                    {' '}— see the <a href={`${config.backend.baseUrl}/docs`} target="_blank" rel="noreferrer">API docs</a> for details.
                </p>
            </div>

            <div className={styles.createSection}>
                <div className={styles.inputsGroup}>
                    <InputTextWithHint
                        hint="Key name"
                        value={newKeyName}
                        onChange={e => setNewKeyName(e.target.value)}
                        placeholder="e.g. My CI server"
                    />
                </div>
                <div className={styles.createFooter}>
                    <PillButton
                        onClick={handleCreate}
                        label={creating ? 'Creating...' : 'Create API key'}
                        icon={ICONS.PLUS}
                        disabled={creating}
                        data-testid="create-api-key"
                    />
                </div>
            </div>

            {createdKey && (
                <div className={styles.createdKeyPanel} data-testid="created-key-panel">
                    <p className={styles.createdKeyTitle}>
                        Key “{createdKey.name}” created — copy it now
                    </p>
                    <p className={styles.createdKeyWarning}>
                        This is the only time the full key is shown. Store it somewhere safe;
                        if you lose it, revoke it and create a new one.
                    </p>
                    <div className={styles.createdKeyRow}>
                        <code className={styles.createdKeyValue}>{createdKey.apiKey}</code>
                        <PillButton
                            onClick={handleCopy}
                            label="Copy"
                            icon={ICONS.COPY}
                            variant="secondary"
                        />
                    </div>
                    <div className={styles.createdKeyDismiss}>
                        <PillButton
                            onClick={() => setCreatedKey(null)}
                            label="I've saved my key"
                            variant="secondary"
                        />
                    </div>
                </div>
            )}

            <div className={styles.listSection}>
                <h3 className={styles.listTitle}>Your API keys</h3>
                {loadingList ? (
                    <p className={styles.emptyState}>Loading…</p>
                ) : keys.length === 0 ? (
                    <p className={styles.emptyState}>No API keys yet.</p>
                ) : (
                    <div className={styles.keyList}>
                        {keys.map(key => (
                            <div key={key.keyId} className={styles.keyRow} data-testid={`key-row-${key.keyId}`}>
                                <div className={styles.keyInfo}>
                                    <span className={styles.keyName}>{key.name}</span>
                                    <code className={styles.keyPrefix}>{key.prefix}…</code>
                                </div>
                                <div className={styles.keyMeta}>
                                    <span>Created {formatDate(key.createdAt)}</span>
                                    <span>Last used {formatDate(key.lastUsedAt)}</span>
                                </div>
                                <PillButton
                                    onClick={() => handleRevoke(key)}
                                    label={revokingKeyId === key.keyId ? 'Revoking...' : 'Revoke'}
                                    variant="danger"
                                    disabled={revokingKeyId === key.keyId}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
