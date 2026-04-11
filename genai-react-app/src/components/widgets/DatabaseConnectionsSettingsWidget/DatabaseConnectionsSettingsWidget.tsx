import React, { useState } from 'react'
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
    const { customerId, getAccessTokenSilently, isAuthenticated, updateVectorDBConfigStatus, updateSupabaseConfigStatus } = useAuth()
    const { showToast } = useToast()

    const [zillizEndpoint, setZillizEndpoint] = useState<string>('')
    const [zillizToken, setZillizToken] = useState<string>('')
    const [savingZilliz, setSavingZilliz] = useState<boolean>(false)

    const [supabaseEndpoint, setSupabaseEndpoint] = useState<string>('')
    const [supabaseKey, setSupabaseKey] = useState<string>('')
    const [savingSupabase, setSavingSupabase] = useState<boolean>(false)

    const handleSaveZilliz = async () => {
        if (!isAuthenticated || !customerId) {
            showToast('Please log in first.')
            return
        }

        const endpointValue = zillizEndpoint.trim()
        const tokenValue = zillizToken.trim()

        if (!endpointValue || !tokenValue) {
            showToast('Please enter both endpoint and token.')
            return
        }

        const endpointRegex = /^https:\/\/[a-zA-Z0-9-]+\.(?:serverless|dedicated)\.[a-zA-Z0-9-]+\.cloud\.zilliz\.com\/?$/i
        if (!endpointRegex.test(endpointValue)) {
            showToast('Invalid Zilliz endpoint format.')
            return
        }

        const tokenRegex = /^[a-fA-F0-9]{64,}$/
        if (!tokenRegex.test(tokenValue)) {
            showToast('Invalid Zilliz token format. Expected a long hex string.')
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
            showToast('Zilliz settings saved successfully.')
        } catch (error: any) {
            console.error(error)
            showToast(error.message || 'Error saving Zilliz settings.')
        } finally {
            setSavingZilliz(false)
        }
    }

    const handleSaveSupabase = async () => {
        if (!isAuthenticated || !customerId) {
            showToast('Please log in first.')
            return
        }

        const endpointValue = supabaseEndpoint.trim()
        const keyValue = supabaseKey.trim()

        if (!endpointValue || !keyValue) {
            showToast('Please enter both endpoint and key.')
            return
        }

        try {
            new URL(endpointValue)
        } catch (_) {
            showToast('Invalid Supabase endpoint format. Please enter a valid URL.')
            return
        }

        setSavingSupabase(true)
        try {
            const token = await getAccessTokenSilently()
            const response = await storeCustomerSupabaseConfig(token, {
                endpoint: supabaseEndpoint,
                token: supabaseKey
            })

            if (response.configStatus && response.configStatus.updateSuccessful) {
                if (updateSupabaseConfigStatus) {
                    updateSupabaseConfigStatus(response.configStatus)
                }
            }
            setSupabaseEndpoint('')
            setSupabaseKey('')
            showToast('Supabase settings saved successfully.')
        } catch (error: any) {
            console.error(error)
            showToast(error.message || 'Error saving Supabase settings.')
        } finally {
            setSavingSupabase(false)
        }
    }

    return (
        <div className={styles.card}>
            <h2 className={styles.title}>Database Settings</h2>
            <div className={styles.form}>
                <div className={styles.vendorSection}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className={styles.vendorName}>Milvus Cloud</span>
                        <CustomerVectorDBConfigStatus vendor="Zilliz" />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <InputTextWithHint
                            hint="Endpoint"
                            value={zillizEndpoint}
                            onChange={e => setZillizEndpoint(e.target.value)}
                            placeholder="https://in03-....zillizcloud.com"
                        />
                        <InputTextWithHint
                            hint="Token"
                            value={zillizToken}
                            onChange={e => setZillizToken(e.target.value)}
                            placeholder="Placeholder token..."
                        />
                    </div>
                    <PillButton
                        onClick={handleSaveZilliz}
                        label={savingZilliz ? 'Saving...' : 'Save'}
                        icon={ICONS.SAVE_ICON}
                        disabled={savingZilliz || !zillizEndpoint.trim() || !zillizToken.trim()}
                    />
                </div>

                <div className={styles.vendorSection}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className={styles.vendorName}>Supabase</span>
                        <CustomerSupabaseConfigStatus />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <InputTextWithHint
                            hint="Endpoint"
                            value={supabaseEndpoint}
                            onChange={e => setSupabaseEndpoint(e.target.value)}
                            placeholder="https://your-project.supabase.co"
                        />
                        <InputTextWithHint
                            hint="Key"
                            value={supabaseKey}
                            onChange={e => setSupabaseKey(e.target.value)}
                            placeholder="your-anon-key"
                        />
                    </div>
                    <PillButton
                        onClick={handleSaveSupabase}
                        label={savingSupabase ? 'Saving...' : 'Save'}
                        icon={ICONS.SAVE_ICON}
                        disabled={savingSupabase || !supabaseEndpoint.trim() || !supabaseKey.trim()}
                    />
                </div>
            </div>
        </div>
    )
}
