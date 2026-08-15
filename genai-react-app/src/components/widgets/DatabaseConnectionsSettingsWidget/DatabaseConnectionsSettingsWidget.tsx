import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { storeCustomerVectorDBConfig } from '../../../services/storeCustomerVectorDBConfigService'
import { storeCustomerSupabaseConfig } from '../../../services/storeCustomerSupabaseConfigService'
import PillButton from '../../common/PillButton/PillButton'
import { ICONS } from '../../../constants/icons'
import { InputTextWithHint } from '../../common/InputTextWithHint/InputTextWithHint'
import { CustomerVectorDBConfigStatus } from '../../common/CustomerVectorDBConfigStatus/CustomerVectorDBConfigStatus'
import { CustomerSupabaseConfigStatus } from '../../common/CustomerSupabaseConfigStatus/CustomerSupabaseConfigStatus'
import { useToast } from '../../../context/ToastContext'
import styles from './DatabaseConnectionsSettingsWidget.module.scss'

export default function DatabaseConnectionsSettingsWidget(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, getAccessTokenSilently, isAuthenticated, updateVectorDBConfigStatus, updateSupabaseConfigStatus } = useAuth()
    const { showToast } = useToast()

    const [zillizEndpoint, setZillizEndpoint] = useState<string>('')
    const [zillizToken, setZillizToken] = useState<string>('')
    const [savingZilliz, setSavingZilliz] = useState<boolean>(false)

    const [supabaseEndpoint, setSupabaseEndpoint] = useState<string>('')
    const [supabaseKey, setSupabaseKey] = useState<string>('')
    const [supabasePassword, setSupabasePassword] = useState<string>('')
    const [savingSupabase, setSavingSupabase] = useState<boolean>(false)

    const handleSaveZilliz = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.pleaseLogInFirst'))
            return
        }

        const endpointValue = zillizEndpoint.trim()
        const tokenValue = zillizToken.trim()

        if (!endpointValue || !tokenValue) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.enterEndpointAndToken'))
            return
        }

        const endpointRegex = /^https:\/\/[a-zA-Z0-9-]+\.(?:serverless|dedicated)\.[a-zA-Z0-9-]+\.cloud\.zilliz\.com\/?$/i
        if (!endpointRegex.test(endpointValue)) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.invalidZillizEndpoint'))
            return
        }

        const tokenRegex = /^[a-fA-F0-9]{64,}$/
        if (!tokenRegex.test(tokenValue)) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.invalidZillizToken'))
            return
        }

        setSavingZilliz(true)
        try {
            const token = await getAccessTokenSilently()
            const response = await storeCustomerVectorDBConfig(token, {
                vendor: 'Zilliz',
                endpoint: zillizEndpoint,
                token: zillizToken
            })

            if (response.configStatus && response.configStatus.updateSuccessful) {
                updateVectorDBConfigStatus(response.configStatus)
            }
            setZillizEndpoint('')
            setZillizToken('')
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.zillizSavedSuccessfully'))
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('dbSettings.databaseConnectionsSettingsWidget.errorSavingZilliz'))
        } finally {
            setSavingZilliz(false)
        }
    }

    const handleSaveSupabase = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.pleaseLogInFirst'))
            return
        }

        const endpointValue = supabaseEndpoint.trim()
        const keyValue = supabaseKey.trim()

        if (!endpointValue || !keyValue) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.enterEndpointAndKey'))
            return
        }

        try {
            new URL(endpointValue)
        } catch (_) {
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.invalidSupabaseEndpoint'))
            return
        }

        setSavingSupabase(true)
        try {
            const token = await getAccessTokenSilently()
            const response = await storeCustomerSupabaseConfig(token, {
                endpoint: supabaseEndpoint,
                token: supabaseKey,
                password: supabasePassword
            })

            if (response.configStatus && response.configStatus.updateSuccessful) {
                if (updateSupabaseConfigStatus) {
                    updateSupabaseConfigStatus(response.configStatus)
                }
            }
            setSupabaseEndpoint('')
            setSupabaseKey('')
            setSupabasePassword('')
            showToast(t('dbSettings.databaseConnectionsSettingsWidget.supabaseSavedSuccessfully'))
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('dbSettings.databaseConnectionsSettingsWidget.errorSavingSupabase'))
        } finally {
            setSavingSupabase(false)
        }
    }

    return (
        <div className={styles.card}>
            <h2 className={styles.title}>{t('dbSettings.databaseConnectionsSettingsWidget.title')}</h2>
            <div className={styles.form}>
                <div className={styles.vendorSection}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className={styles.vendorName}>{t('dbSettings.databaseConnectionsSettingsWidget.milvusCloud')}</span>
                        <CustomerVectorDBConfigStatus vendor="Zilliz" />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <InputTextWithHint
                            hint={t('dbSettings.databaseConnectionsSettingsWidget.endpointHint')}
                            value={zillizEndpoint}
                            onChange={e => setZillizEndpoint(e.target.value)}
                            placeholder={t('dbSettings.databaseConnectionsSettingsWidget.zillizEndpointPlaceholder')}
                        />
                        <InputTextWithHint
                            hint={t('dbSettings.databaseConnectionsSettingsWidget.tokenHint')}
                            value={zillizToken}
                            onChange={e => setZillizToken(e.target.value)}
                            placeholder={t('dbSettings.databaseConnectionsSettingsWidget.zillizTokenPlaceholder')}
                        />
                    </div>
                    <PillButton
                        onClick={handleSaveZilliz}
                        label={savingZilliz ? t('dbSettings.databaseConnectionsSettingsWidget.saving') : t('dbSettings.databaseConnectionsSettingsWidget.save')}
                        icon={ICONS.SAVE_ICON}
                        disabled={savingZilliz || !zillizEndpoint.trim() || !zillizToken.trim()}
                    />
                </div>

                <div className={styles.vendorSection}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className={styles.vendorName}>{t('dbSettings.databaseConnectionsSettingsWidget.supabase')}</span>
                        <CustomerSupabaseConfigStatus />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <InputTextWithHint
                            hint={t('dbSettings.databaseConnectionsSettingsWidget.endpointHint')}
                            value={supabaseEndpoint}
                            onChange={e => setSupabaseEndpoint(e.target.value)}
                            placeholder={t('dbSettings.databaseConnectionsSettingsWidget.supabaseEndpointPlaceholder')}
                        />
                        <InputTextWithHint
                            hint={t('dbSettings.databaseConnectionsSettingsWidget.keyHint')}
                            value={supabaseKey}
                            onChange={e => setSupabaseKey(e.target.value)}
                            placeholder={t('dbSettings.databaseConnectionsSettingsWidget.supabaseKeyPlaceholder')}
                        />
                        <InputTextWithHint
                            hint={t('dbSettings.databaseConnectionsSettingsWidget.passwordHint')}
                            value={supabasePassword}
                            onChange={e => setSupabasePassword(e.target.value)}
                            placeholder={t('dbSettings.databaseConnectionsSettingsWidget.supabasePasswordPlaceholder')}
                            type="password"
                        />
                    </div>
                    <PillButton
                        onClick={handleSaveSupabase}
                        label={savingSupabase ? t('dbSettings.databaseConnectionsSettingsWidget.saving') : t('dbSettings.databaseConnectionsSettingsWidget.save')}
                        icon={ICONS.SAVE_ICON}
                        disabled={savingSupabase || !supabaseEndpoint.trim() || !supabaseKey.trim() || !supabasePassword.trim()}
                    />
                </div>
            </div>
        </div>
    )
}
