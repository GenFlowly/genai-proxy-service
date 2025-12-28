import React, { useState } from 'react'
import Navbar from '../components/navbar/Navbar'
import styles from './SettingsPage.module.scss'
import { useAuth } from '../context/AuthContext'
import { AIVendor } from '../constants/vendors'
import { storeCustomerVendorApiKey } from '../services/storeCustomerVendorApiKeysService'
import PillButton from '../components/common/PillButton/PillButton'
import { Icon } from '../components/common/Icon/Icon'
import { ICONS } from '../constants/icons'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName
} from '../components/common/BrandName/BrandName'
import { InputTextWithHint } from '../components/common/InputTextWithHint/InputTextWithHint'

export default function SettingsPage(): React.ReactElement {
    const { customerId, getAccessTokenSilently, isAuthenticated, aiVendorAPIKeyStatusList } = useAuth()

    const vendors = Object.values(AIVendor) as AIVendor[]

    const [apiKeys, setApiKeys] = useState<Record<AIVendor, string>>({
        [AIVendor.OPENAI]: '',
        [AIVendor.CLAUDE]: '',
        [AIVendor.GEMINI]: '',
    })

    const [savedVendors, setSavedVendors] = useState<Record<AIVendor, boolean>>({
        [AIVendor.OPENAI]: false,
        [AIVendor.CLAUDE]: false,
        [AIVendor.GEMINI]: false,
    })

    const [message, setMessage] = useState<string | null>(null)
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
            alert('Please log in first.')
            return
        }

        const apiKey = apiKeys[vendor]
        if (!apiKey.trim()) {
            alert('Please enter an API key.')
            return
        }

        if (savedVendors[vendor]) {
            const confirmOverwrite = window.confirm(
                `An API key for ${vendor} already exists. Overwrite it?`
            )
            if (!confirmOverwrite) return
        }

        try {
            setLoading(prev => ({ ...prev, [vendor]: true }))
            const token = await getAccessTokenSilently()

            await storeCustomerVendorApiKey(token, {
                customerId,
                aiVendor: vendor,
                apiKey,
            })

            setSavedVendors(prev => ({ ...prev, [vendor]: true }))

            setApiKeys(prev => ({ ...prev, [vendor]: '' })) // ✅ Clear input
            setMessage(`${vendor} API key saved successfully.`)
        } catch (error: any) {
            console.error(error)
            setMessage(error.message || 'Error saving API key.')
        } finally {
            setLoading(prev => ({ ...prev, [vendor]: false }))
            setTimeout(() => setMessage(null), 3000)
        }
    }

    // Helper to check status
    const isVendorKeyValid = (vendor: AIVendor) => {
        const status = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
        return status?.isAPIKeyValid
    }

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.content}>
                <div className={styles.card}>
                    <h2 className={styles.title}>AI Vendor API Keys</h2>

                    <div className={styles.form}>
                        {vendors.map(vendor => {
                            const isValid = isVendorKeyValid(vendor)

                            let BrandComponent = <span className={styles.vendorName}>{vendor}</span>
                            if (vendor === AIVendor.OPENAI) BrandComponent = <OpenAIBrandName className={styles.vendorBrand} />
                            if (vendor === AIVendor.CLAUDE) BrandComponent = <ClaudeBrandName className={styles.vendorBrand} />
                            if (vendor === AIVendor.GEMINI) BrandComponent = <GeminiBrandName className={styles.vendorBrand} />

                            return (
                                <div key={vendor} className={styles.vendorSection}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        {BrandComponent}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            {isValid ? (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-success)' }}>
                                                    <Icon src={ICONS.VALID} size={16} />
                                                    <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>API Key Valid</span>
                                                </div>
                                            ) : (
                                                <span style={{ color: '#6B7280', fontSize: '0.9rem' }}>No API Key set</span>
                                            )}
                                        </div>
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

                        {message && (
                            <div className={styles.successMessage}>{message}</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}