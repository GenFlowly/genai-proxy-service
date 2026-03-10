import React, { useState } from 'react'
import Navbar from '../components/navbar/Navbar'
import styles from './SettingsPage.module.scss'
import { useAuth } from '../context/AuthContext'
import { AIVendor } from '../constants/vendors'
import { storeCustomerVendorApiKey } from '../services/storeCustomerVendorApiKeysService'
import { storeCustomerVectorDBConfig } from '../services/storeCustomerVectorDBConfigService'
import PillButton from '../components/common/PillButton/PillButton'
import { ICONS } from '../constants/icons'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName
} from '../components/common/BrandName/BrandName'
import { InputTextWithHint } from '../components/common/InputTextWithHint/InputTextWithHint'
import { VendorAPIKeyStatus } from '../components/common/VendorAPIKeyStatus/VendorAPIKeyStatus'
import { CustomerVectorDBConfigStatus } from '../components/common/CustomerVectorDBConfigStatus/CustomerVectorDBConfigStatus'

import { useToast } from '../context/ToastContext'

export default function SettingsPage(): React.ReactElement {
    const { customerId, getAccessTokenSilently, isAuthenticated, updateVendorApiKeyStatus, updateVectorDBConfigStatus } = useAuth()
    const { showToast } = useToast()

    const vendors = Object.values(AIVendor) as AIVendor[]

    const [apiKeys, setApiKeys] = useState<Record<AIVendor, string>>({
        [AIVendor.OPENAI]: '',
        [AIVendor.CLAUDE]: '',
        [AIVendor.GEMINI]: '',
    })



    const [loading, setLoading] = useState<Record<AIVendor, boolean>>({
        [AIVendor.OPENAI]: false,
        [AIVendor.CLAUDE]: false,
        [AIVendor.GEMINI]: false,
    })

    const [zillizEndpoint, setZillizEndpoint] = useState<string>('')
    const [zillizToken, setZillizToken] = useState<string>('')
    const [savingZilliz, setSavingZilliz] = useState<boolean>(false)

    const handleChange = (vendor: AIVendor, value: string) => {
        setApiKeys(prev => ({ ...prev, [vendor]: value }))
    }

    const handleSave = async (vendor: AIVendor) => {
        if (!isAuthenticated || !customerId) {
            showToast('Please log in first.')
            return
        }

        const apiKey = apiKeys[vendor]
        if (!apiKey.trim()) {
            showToast('Please enter a valid API key.')
            return
        }



        try {
            setLoading(prev => ({ ...prev, [vendor]: true }))
            const token = await getAccessTokenSilently()

            const response = await storeCustomerVendorApiKey(token, {
                aiVendor: vendor,
                apiKey,
            })



            // Update global context status only on successful update
            if (response.apiKeyStatus.updateSuccessful) {
                updateVendorApiKeyStatus(response.apiKeyStatus)
            }

            setApiKeys(prev => ({ ...prev, [vendor]: '' })) // ✅ Clear input

            // Show the status message from backend
            showToast(response.apiKeyStatus.status)
        } catch (error: any) {
            console.error(error)
            showToast(error.message || 'Error saving API key.')
        } finally {
            setLoading(prev => ({ ...prev, [vendor]: false }))
        }
    }

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

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.content}>
                <div className={styles.card}>
                    <h2 className={styles.title}>AI Vendor API Keys</h2>

                    <div className={styles.form}>
                        {vendors.map(vendor => {


                            let BrandComponent = <span className={styles.vendorName}>{vendor}</span>
                            if (vendor === AIVendor.OPENAI) BrandComponent = <OpenAIBrandName className={styles.vendorBrand} />
                            if (vendor === AIVendor.CLAUDE) BrandComponent = <ClaudeBrandName className={styles.vendorBrand} />
                            if (vendor === AIVendor.GEMINI) BrandComponent = <GeminiBrandName className={styles.vendorBrand} />

                            return (
                                <div key={vendor} className={styles.vendorSection}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        {BrandComponent}
                                        <VendorAPIKeyStatus vendor={vendor} />
                                    </div>

                                    <div >
                                        <InputTextWithHint
                                            hint="API Key"
                                            value={apiKeys[vendor]}
                                            onChange={e => handleChange(vendor, e.target.value)}
                                            placeholder="sk-..."

                                        />
                                    </div>

                                    <PillButton
                                        onClick={() => handleSave(vendor)}
                                        label={loading[vendor] ? 'Saving...' : 'Save'}
                                        icon={ICONS.SAVE_ICON}
                                        disabled={loading[vendor]}
                                    />
                                </div>
                            )
                        })}


                    </div>
                </div>

                <div className={styles.card}>
                    <h2 className={styles.title}>Vector Database Settings</h2>
                    <div className={styles.form}>
                        <div className={styles.vendorSection}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <span className={styles.vendorName}>Zilliz Cloud</span>
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
                    </div>
                </div>
            </div>
        </div>
    )
}