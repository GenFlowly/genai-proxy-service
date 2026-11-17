import React from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsCard, SettingsRow, StatusPill } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { VectorDBConfigStatusValue } from '../../../models/storeCustomerVectorDBConfig.models'
import DatabaseConnectionsSettingsWidget from '../../../components/widgets/DatabaseConnectionsSettingsWidget/DatabaseConnectionsSettingsWidget'
import { SettingsFrame } from './SettingsFrame'
import { useSettingsShell } from '../SettingsShellContext'

/**
 * BYOK Settings › Vector DB Connection: the customer's own Zilliz database.
 * The form is the shared DatabaseConnectionsSettingsWidget (also used by
 * onboarding), so the two never drift apart.
 */
export function VectorDBSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { vectorDBConfigStatusList } = useAuth()
    const { narrow } = useSettingsShell()
    const connected = vectorDBConfigStatusList.some(
        status => status.vendor?.toLowerCase() === 'zilliz' && status.status === VectorDBConfigStatusValue.PRESENT
    )
    const statusText = connected ? t('settingsPage.vectorDb.connected') : t('settingsPage.vectorDb.notConnected')
    const knowledge = [
        { title: t('settingsPage.vectorDb.storesTitle'), text: t('settingsPage.vectorDb.storesText') },
        { title: t('settingsPage.vectorDb.needTitle'), text: t('settingsPage.vectorDb.needText') },
        { title: t('settingsPage.vectorDb.changeTitle'), text: t('settingsPage.vectorDb.changeText') },
    ]

    return (
        <SettingsFrame
            page="byok-vector-db"
            knowledge={knowledge}
            statusText={statusText}
            status={<StatusPill kind={connected ? 'ok' : 'unset'}>{statusText}</StatusPill>}
        >
            {connected && (
                <SettingsCard
                    title={t('dbSettings.databaseConnectionsSettingsWidget.milvusCloud')}
                    pills={<StatusPill kind="ok">{statusText}</StatusPill>}
                    data-testid="vector-db-connected"
                >
                    <SettingsRow label={t('settingsPage.vectorDb.tokenRow')} description={t('settingsPage.vectorDb.tokenSaved')} stackOnNarrow={false} />
                </SettingsCard>
            )}
            <DatabaseConnectionsSettingsWidget
                narrow={narrow}
                title={connected ? t('settingsPage.vectorDb.replaceCard') : undefined}
                hideStatus={connected}
            />
        </SettingsFrame>
    )
}
