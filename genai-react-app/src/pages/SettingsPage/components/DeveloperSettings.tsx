import React, { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { config } from '../../../config/env'
import { PillButton } from '@genflowly/component-library'
import { InputTextWithHint } from '@genflowly/component-library'
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
import { formatServerDateOnly } from '../../../utils/timeUtils'

function formatDate(iso?: string): string {
    return formatServerDateOnly(iso) || '—'
}

export function DeveloperSettings(): React.ReactElement {
    const { t } = useTranslation()
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
            showToast(error.message || t('settingsPage.developerSettings.loadErrorToast'))
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
            const token = await getAccessTokenSilently()
            const created = await createDeveloperApiKey(token, { name })
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

    const handleRevoke = async (key: DeveloperApiKeySummary) => {
        if (!window.confirm(t('settingsPage.developerSettings.revokeConfirm', { name: key.name }))) {
            return
        }
        try {
            setRevokingKeyId(key.keyId)
            const token = await getAccessTokenSilently()
            await revokeDeveloperApiKey(token, key.keyId)
            // The revoked key can no longer be the "just created" one worth showing
            if (createdKey?.keyId === key.keyId) setCreatedKey(null)
            showToast(t('settingsPage.developerSettings.revokedToast'))
            await loadKeys()
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.developerSettings.revokeErrorToast'))
        } finally {
            setRevokingKeyId(null)
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.developerSettings.title')}</h2>
                <p className={styles.subtitle}>
                    <Trans i18nKey="settingsPage.developerSettings.subtitle">
                        Create API keys to call the API from your own code instead of logging in.
                        Send a key on every request as <code className={styles.inlineCode}>Authorization: Bearer gfy_...</code> — see
                        the <a href={`${config.backend.baseUrl}/docs`} target="_blank" rel="noreferrer">API docs</a> for details.
                    </Trans>
                </p>
            </div>

            <div className={styles.createSection}>
                <div className={styles.inputsGroup}>
                    <InputTextWithHint
                        hint={t('settingsPage.developerSettings.keyNameHint')}
                        value={newKeyName}
                        onChange={e => setNewKeyName(e.target.value)}
                        placeholder={t('settingsPage.developerSettings.keyNamePlaceholder')}
                    />
                </div>
                <div className={styles.createFooter}>
                    <PillButton
                        onClick={handleCreate}
                        label={creating ? t('settingsPage.developerSettings.creatingLabel') : t('settingsPage.developerSettings.createApiKey')}
                        icon={ICONS.PLUS}
                        disabled={creating}
                        data-testid="create-api-key"
                    />
                </div>
            </div>

            {createdKey && (
                <div className={styles.createdKeyPanel} data-testid="created-key-panel">
                    <p className={styles.createdKeyTitle}>
                        {t('settingsPage.developerSettings.createdKeyTitle', { name: createdKey.name })}
                    </p>
                    <p className={styles.createdKeyWarning}>
                        {t('settingsPage.developerSettings.createdKeyWarning')}
                    </p>
                    <div className={styles.createdKeyRow}>
                        <code className={styles.createdKeyValue}>{createdKey.apiKey}</code>
                        <PillButton
                            onClick={handleCopy}
                            label={t('settingsPage.developerSettings.copy')}
                            icon={ICONS.COPY}
                            variant="secondary"
                        />
                    </div>
                    <div className={styles.createdKeyDismiss}>
                        <PillButton
                            onClick={() => setCreatedKey(null)}
                            label={t('settingsPage.developerSettings.savedMyKey')}
                            variant="secondary"
                        />
                    </div>
                </div>
            )}

            <div className={styles.listSection}>
                <h3 className={styles.listTitle}>{t('settingsPage.developerSettings.yourApiKeys')}</h3>
                {loadingList ? (
                    <p className={styles.emptyState}>{t('settingsPage.developerSettings.loading')}</p>
                ) : keys.length === 0 ? (
                    <p className={styles.emptyState}>{t('settingsPage.developerSettings.noKeysYet')}</p>
                ) : (
                    <div className={styles.keyList}>
                        {keys.map(key => (
                            <div key={key.keyId} className={styles.keyRow} data-testid={`key-row-${key.keyId}`}>
                                <div className={styles.keyInfo}>
                                    <span className={styles.keyName}>{key.name}</span>
                                    <code className={styles.keyPrefix}>{key.prefix}…</code>
                                </div>
                                <div className={styles.keyMeta}>
                                    <span>{t('settingsPage.developerSettings.createdOn', { date: formatDate(key.createdAt) })}</span>
                                    <span>{t('settingsPage.developerSettings.lastUsedOn', { date: formatDate(key.lastUsedAt) })}</span>
                                </div>
                                <PillButton
                                    onClick={() => handleRevoke(key)}
                                    label={revokingKeyId === key.keyId ? t('settingsPage.developerSettings.revokingLabel') : t('settingsPage.developerSettings.revoke')}
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
