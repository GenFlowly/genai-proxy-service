import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { SettingsCard, SettingsRow, StatusPill, ToggleRow } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService'
import { EmbeddingKeyStatus, EmbeddingVendor, getEmbeddingKeys } from '../../../services/embeddingKeysService'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { VectorDBConfigStatusValue } from '../../../models/storeCustomerVectorDBConfig.models'
import { getAiPreferences, subscribeAiPreferences } from '../../../stores/aiPreferencesStore'
import { useHasOwnKeys } from '../../../hooks/useHasOwnKeys'
import { PLATFORM_EMBEDDING_MODEL, chosenEmbeddingModel } from '../../../utils/embeddingModel'
import { SettingsFrame } from './SettingsFrame'
import styles from './ChatIndexingSettings.module.scss'

const keyReady = (status?: EmbeddingKeyStatus) => status?.status === APIKeyStatus.VALID || !!status?.isAPIKeyValid

/**
 * Defaults › Search index: whether new chats are saved for search. Indexing
 * stays off until the user turns it on (an unset preference means off,
 * matching the backend). For own-key customers it shows what indexing needs;
 * deleting what is indexed lives on Profile › Delete your data.
 */
export function ChatIndexingSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently, vectorDBConfigStatusList } = useAuth()
    const { showToast } = useToast()
    const hasOwnKeys = useHasOwnKeys()
    const preferences = useSyncExternalStore(subscribeAiPreferences, getAiPreferences)
    const [saving, setSaving] = useState<boolean | null>(null)
    const [keyStatuses, setKeyStatuses] = useState<EmbeddingKeyStatus[] | null>(null)

    useEffect(() => {
        if (!isAuthenticated || !hasOwnKeys) return
        let active = true
        getAccessTokenSilently()
            .then(token => getEmbeddingKeys(token))
            .then(response => { if (active) setKeyStatuses(response.statuses) })
            .catch(error => console.error('Failed to load embedding key statuses', error))
        return () => { active = false }
    }, [isAuthenticated, hasOwnKeys, getAccessTokenSilently])

    const isOn = saving ?? preferences?.indexChats === true

    const handleToggle = async (checked: boolean) => {
        if (!isAuthenticated) {
            showToast(t('settingsPage.chatIndexing.loginFirstToast'))
            return
        }
        setSaving(checked)
        try {
            const token = await getAccessTokenSilently()
            await saveAIConfigPreferences(token, { aiConfigPreferences: { indexChats: checked } })
        } catch (error: any) {
            console.error('Failed to save the chat indexing setting:', error)
            showToast(error?.message || t('settingsPage.chatIndexing.saveErrorToast'))
        } finally {
            setSaving(null)
        }
    }

    const databaseReady = vectorDBConfigStatusList.some(status => status.status === VectorDBConfigStatusValue.PRESENT)
    const searchKeyReady = keyStatuses == null
        ? null
        : [EmbeddingVendor.OPENAI, EmbeddingVendor.VOYAGE].some(vendor => keyReady(keyStatuses.find(s => s.vendor === vendor)))
    const model = chosenEmbeddingModel(preferences)
    const statusText = isOn ? t('settingsPage.searchIndex.on') : t('settingsPage.searchIndex.off')
    const knowledge = [
        { title: t('settingsPage.searchIndex.doesTitle'), text: t('settingsPage.searchIndex.doesText') },
        ...(hasOwnKeys ? [{ title: t('settingsPage.searchIndex.needsTitle'), text: t('settingsPage.searchIndex.needsText') }] : []),
    ]
    const setupPath = !databaseReady ? '/settings/byok/vector-db' : '/settings/byok/embedding-keys'

    return (
        <SettingsFrame
            page="search-index"
            knowledge={knowledge}
            statusText={statusText}
            status={<StatusPill kind={isOn ? 'ok' : 'unset'}>{statusText}</StatusPill>}
        >
            <SettingsCard title={t('settingsPage.searchIndex.card')}>
                <ToggleRow
                    label={t('settingsPage.chatIndexing.indexChats')}
                    checked={isOn}
                    onChange={checked => void handleToggle(checked)}
                    disabled={saving !== null}
                    data-testid="chat-indexing-switch"
                />
                {hasOwnKeys && (
                    <SettingsRow
                        label={t('settingsPage.searchIndex.needsTitle')}
                        stackOnNarrow={false}
                        data-testid="search-index-requirements"
                        action={
                            (!databaseReady || searchKeyReady === false) && (
                                <Link to={setupPath} className={styles.link}>{t('settingsPage.searchIndex.setUp')}</Link>
                            )
                        }
                    >
                        <span className={styles.pills}>
                            <StatusPill kind={databaseReady ? 'ok' : 'unset'}>
                                {databaseReady ? t('settingsPage.searchIndex.databaseReady') : t('settingsPage.searchIndex.databaseNotSet')}
                            </StatusPill>
                            {searchKeyReady != null && (
                                <StatusPill kind={searchKeyReady ? 'ok' : 'unset'}>
                                    {searchKeyReady ? t('settingsPage.searchIndex.keyReady') : t('settingsPage.searchIndex.keyNotSet')}
                                </StatusPill>
                            )}
                        </span>
                    </SettingsRow>
                )}
                <SettingsRow
                    label={t('settingsPage.searchIndex.modelRow')}
                    description={model ?? t('settingsPage.searchIndex.platformDefault', { model: PLATFORM_EMBEDDING_MODEL })}
                    stackOnNarrow={false}
                    action={
                        <Link to="/settings/defaults/embedding-models" className={styles.link}>
                            {model ? t('settingsPage.searchIndex.modelDetails') : t('settingsPage.searchIndex.modelChange')}
                        </Link>
                    }
                />
            </SettingsCard>
        </SettingsFrame>
    )
}
