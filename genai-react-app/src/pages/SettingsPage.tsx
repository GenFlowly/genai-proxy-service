import React, { useState } from 'react'
import Navbar from '../components/Navbar'
import styles from './SettingsPage.module.scss'
import { useAuth } from '../context/AuthContext'
import { AIVendor } from '../constants/vendors'
import { storeCustomerVendorApiKey } from '../services/storeApiKeys'

export default function SettingsPage(): React.ReactElement {
    const { customerId, getAccessTokenSilently, isAuthenticated } = useAuth()

    const vendors = Object.values(AIVendor) as AIVendor[]

    const [apiKeys, setApiKeys] = useState<Record<AIVendor, string>>({
        [AIVendor.OPENAI]: '',
        [AIVendor.ANTHROPIC]: '',
        [AIVendor.GEMINI]: '',
    })

    const [savedVendors, setSavedVendors] = useState<Record<AIVendor, boolean>>({
        [AIVendor.OPENAI]: false,
        [AIVendor.ANTHROPIC]: false,
        [AIVendor.GEMINI]: false,
    })

    const [message, setMessage] = useState<string | null>(null)
    const [loading, setLoading] = useState<Record<AIVendor, boolean>>({
        [AIVendor.OPENAI]: false,
        [AIVendor.ANTHROPIC]: false,
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

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.content}>
                <div className={styles.card}>
                    <h2 className={styles.title}>AI Vendor Settings</h2>

                    <div className={styles.form}>
                        {vendors.map(vendor => (
                            <div key={vendor} className={styles.vendorSection}>
                                <h3 className={styles.vendorName}>{vendor}</h3>

                                <div className={styles.formGroup}>
                                    <label className={styles.formLabel}>API Key</label>
                                    <input
                                        type="password"
                                        placeholder="sk-..."
                                        value={apiKeys[vendor]}
                                        onChange={e => handleChange(vendor, e.target.value)}
                                        className={styles.formInput}
                                    />
                                    {savedVendors[vendor] && (
                                        <p className={styles.keyStatus}>✅ Key is set</p>
                                    )}
                                </div>

                                <button
                                    onClick={() => handleSave(vendor)}
                                    className={styles.submitButton}
                                    disabled={loading[vendor]}
                                >
                                    {loading[vendor] ? 'Saving...' : 'Save'}
                                </button>
                            </div>
                        ))}

                        {message && (
                            <div className={styles.successMessage}>{message}</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}