import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { storeCustomerVectorDBConfig } from '../../../services/storeCustomerVectorDBConfigService'
import { storeCustomerSupabaseConfig } from '../../../services/storeCustomerSupabaseConfigService'
import { PillButton } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { InputTextWithHint } from '@genflowly/component-library'
import { CustomerVectorDBConfigStatus } from '../../../components/common/CustomerVectorDBConfigStatus/CustomerVectorDBConfigStatus'
import { CustomerSupabaseConfigStatus } from '../../../components/common/CustomerSupabaseConfigStatus/CustomerSupabaseConfigStatus'
import { useToast } from '../../../context/ToastContext'
import styles from './MemorySettings.module.scss'

export function MemorySettings(): React.ReactElement {
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
            showToast(t('settingsPage.memorySettings.loginFirstToast'))
            return
        }

        const endpointValue = zillizEndpoint.trim()
        const tokenValue = zillizToken.trim()

        if (!endpointValue || !tokenValue) {
            showToast(t('settingsPage.memorySettings.enterEndpointAndTokenToast'))
            return
        }

        const endpointRegex = /^https:\/\/[a-zA-Z0-9-]+\.(?:serverless|dedicated)\.[a-zA-Z0-9-]+\.cloud\.zilliz\.com\/?$/i
        if (!endpointRegex.test(endpointValue)) {
            showToast(t('settingsPage.memorySettings.invalidZillizEndpointToast'))
            return
        }

        const tokenRegex = /^[a-fA-F0-9]{64,}$/
        if (!tokenRegex.test(tokenValue)) {
            showToast(t('settingsPage.memorySettings.invalidZillizTokenToast'))
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
            showToast(t('settingsPage.memorySettings.zillizSavedToast'))
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.memorySettings.zillizSaveErrorToast'))
        } finally {
            setSavingZilliz(false)
        }
    }

    const handleSaveSupabase = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('settingsPage.memorySettings.loginFirstToast'))
            return
        }

        const endpointValue = supabaseEndpoint.trim()
        const keyValue = supabaseKey.trim()

        if (!endpointValue || !keyValue) {
            showToast(t('settingsPage.memorySettings.enterEndpointAndKeyToast'))
            return
        }

        try {
            new URL(endpointValue)
        } catch (_) {
            showToast(t('settingsPage.memorySettings.invalidSupabaseEndpointToast'))
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
            showToast(t('settingsPage.memorySettings.supabaseSavedToast'))
        } catch (error: any) {
            console.error(error)
            showToast(error.message || t('settingsPage.memorySettings.supabaseSaveErrorToast'))
        } finally {
            setSavingSupabase(false)
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.memorySettings.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.memorySettings.subtitle')}</p>
            </div>
            
            <div className={styles.form}>
                <div className={styles.vendorSection}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className={styles.vendorName}>Milvus Cloud</span>
                        <CustomerVectorDBConfigStatus vendor="Zilliz" />
                    </div>
                    <div className={styles.inputsGroup}>
                        <InputTextWithHint
                            hint={t('settingsPage.memorySettings.endpointHint')}
                            value={zillizEndpoint}
                            onChange={e => setZillizEndpoint(e.target.value)}
                            placeholder="https://in03-....zillizcloud.com"
                        />
                        <InputTextWithHint
                            hint={t('settingsPage.memorySettings.tokenHint')}
                            value={zillizToken}
                            onChange={e => setZillizToken(e.target.value)}
                            placeholder={t('settingsPage.memorySettings.zillizTokenPlaceholder')}
                        />
                    </div>
                    <div className={styles.footer}>
                    <PillButton
                        onClick={handleSaveZilliz}
                        label={savingZilliz ? t('settingsPage.memorySettings.savingLabel') : t('settingsPage.memorySettings.save')}
                        icon={ICONS.SAVE_ICON}
                        disabled={savingZilliz || !zillizEndpoint.trim() || !zillizToken.trim()}
                    />
                    </div>
                </div>

                <div className={styles.vendorSection}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className={styles.vendorName}>Supabase</span>
                        <CustomerSupabaseConfigStatus />
                    </div>
                    <div className={styles.inputsGroup}>
                        <InputTextWithHint
                            hint={t('settingsPage.memorySettings.endpointHint')}
                            value={supabaseEndpoint}
                            onChange={e => setSupabaseEndpoint(e.target.value)}
                            placeholder={t('settingsPage.memorySettings.supabaseEndpointPlaceholder')}
                        />
                        <InputTextWithHint
                            hint={t('settingsPage.memorySettings.keyHint')}
                            value={supabaseKey}
                            onChange={e => setSupabaseKey(e.target.value)}
                            placeholder={t('settingsPage.memorySettings.supabaseKeyPlaceholder')}
                        />
                        <InputTextWithHint
                            hint={t('settingsPage.memorySettings.passwordHint')}
                            value={supabasePassword}
                            onChange={e => setSupabasePassword(e.target.value)}
                            placeholder={t('settingsPage.memorySettings.supabasePasswordPlaceholder')}
                            type="password"
                        />
                    </div>
                    <div className={styles.footer}>
                    <PillButton
                        onClick={handleSaveSupabase}
                        label={savingSupabase ? t('settingsPage.memorySettings.savingLabel') : t('settingsPage.memorySettings.save')}
                        icon={ICONS.SAVE_ICON}
                        disabled={savingSupabase || !supabaseEndpoint.trim() || !supabaseKey.trim() || !supabasePassword.trim()}
                    />
                    </div>
                </div>
            </div>
        </div>
    )
}
