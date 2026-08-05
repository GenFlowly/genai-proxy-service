import React, { useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { storeCustomerVendorApiKey } from '../../../services/storeCustomerVendorApiKeysService'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import PillButton from '../../../components/common/PillButton/PillButton'
import { ICONS } from '../../../constants/icons'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName
} from '../../../components/common/BrandName/BrandName'
import { InputTextWithHint } from '../../../components/common/InputTextWithHint/InputTextWithHint'
import { VendorAPIKeyStatus } from '../../../components/common/VendorAPIKeyStatus/VendorAPIKeyStatus'
import { useToast } from '../../../context/ToastContext'
import styles from './AISettings.module.scss'

export function AISettings(): React.ReactElement {
    const { customerId, getAccessTokenSilently, isAuthenticated, updateVendorApiKeyStatus, aiVendorAPIKeyStatusList } = useAuth()
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

            if (response.apiKeyStatus.updateSuccessful) {
                updateVendorApiKeyStatus(response.apiKeyStatus)
            }
            setApiKeys(prev => ({ ...prev, [vendor]: '' }))
            showToast(response.apiKeyStatus.status)
        } catch (error: any) {
            console.error(error)
            showToast(error.message || 'Error saving API key.')
        } finally {
            setLoading(prev => ({ ...prev, [vendor]: false }))
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>AI Models & Providers</h2>
                <p className={styles.subtitle}>Configure your API keys to enable various AI models across the platform.</p>
            </div>
            <div className={styles.form}>
                {vendors.map(vendor => {
                    let BrandComponent = <span className={styles.vendorName}>{vendor}</span>
                    if (vendor === AIVendor.OPENAI) BrandComponent = <OpenAIBrandName className={styles.vendorBrand} />
                    if (vendor === AIVendor.CLAUDE) BrandComponent = <ClaudeBrandName className={styles.vendorBrand} />
                    if (vendor === AIVendor.GEMINI) BrandComponent = <GeminiBrandName className={styles.vendorBrand} />

                    const vendorStatus = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
                    const isCurrentlyValid = vendorStatus?.status === APIKeyStatus.VALID || vendorStatus?.isAPIKeyValid

                    return (
                        <div key={vendor} className={styles.vendorSection}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                {BrandComponent}
                                <VendorAPIKeyStatus vendor={vendor} />
                            </div>
                            <div className={styles.inputsGroup}>
                                <InputTextWithHint
                                    hint="API Key"
                                    value={apiKeys[vendor]}
                                    onChange={e => handleChange(vendor, e.target.value)}
                                    placeholder="sk-..."
                                    type="password"
                                />
                            </div>
                            <div className={styles.footer}>
                                <PillButton
                                    onClick={() => handleSave(vendor)}
                                    label={loading[vendor] ? 'Saving...' : (isCurrentlyValid ? 'Overwrite API Key' : 'Save')}
                                    icon={ICONS.SAVE_ICON}
                                    disabled={loading[vendor]}
                                />
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
