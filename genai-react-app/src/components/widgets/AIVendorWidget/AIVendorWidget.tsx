import React, { useEffect, useState } from 'react'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { getTextGenerationModels, clearModelCache } from '../../../services/modelService'
import styles from './AIVendorWidget.module.scss'

export default function AIVendorWidget(): React.ReactElement {
    const { config, setVendorModel } = useAI()
    const { getAccessTokenSilently, customerId, isAuthenticated } = useAuth()

    const [vendorModels, setVendorModels] = useState<
        Record<AIVendor, { models: string[]; loading: boolean; error?: string }>
    >({
        [AIVendor.OPENAI]: { models: [], loading: false },
        [AIVendor.CLAUDE]: { models: [], loading: false },
        [AIVendor.GEMINI]: { models: [], loading: false },
    })

    const vendors = Object.values(AIVendor) as AIVendor[]

    const fetchModels = async (bypassCache: boolean = false) => {
        if (!isAuthenticated || !customerId) return

        try {
            const token = await getAccessTokenSilently()
            for (const vendor of vendors) {
                setVendorModels(prev => ({
                    ...prev,
                    [vendor]: { ...prev[vendor], loading: true },
                }))

                try {
                    // Clear cache for this vendor if bypassing
                    if (bypassCache) {
                        clearModelCache(vendor, customerId)
                    }

                    const res = await getTextGenerationModels(
                        token,
                        { vendor, customerId },
                        bypassCache
                    )
                    setVendorModels(prev => ({
                        ...prev,
                        [vendor]: { loading: false, models: res.modelsList },
                    }))
                } catch (err) {
                    console.error(`Error fetching models for ${vendor}:`, err)
                    setVendorModels(prev => ({
                        ...prev,
                        [vendor]: { loading: false, models: [], error: 'Failed to load models' },
                    }))
                }
            }
        } catch (err) {
            console.error('Error fetching vendor models:', err)
        }
    }

    // Initial load
    useEffect(() => {
        if (!isAuthenticated || !customerId) return
        fetchModels()
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    const handleRefresh = () => {
        fetchModels(true) // bypass cache
    }

    return (
        <div className={styles.vendorWidget}>
            <div className={styles.header}>
                <h3 className={styles.title}>AI Models</h3>
                <button
                    onClick={handleRefresh}
                    className={styles.refreshButton}
                    title="Refresh model list"
                    disabled={Object.values(vendorModels).some(v => v.loading)}
                >
                    ↻ Refresh
                </button>
            </div>

            {vendors.map(vendor => (
                <div key={vendor} className={styles.vendorBlock}>
                    <button
                        type="button"
                        className={`${styles.vendorButton} ${
                            config.vendorSelections[vendor] ? styles.selected : ''
                        }`}
                        onClick={() =>
                            setVendorModel(
                                vendor,
                                config.vendorSelections[vendor]
                                    ? null
                                    : vendorModels[vendor].models[0]
                            )
                        }
                        disabled={vendorModels[vendor].loading}
                    >
                        {vendor}
                        {vendorModels[vendor].loading && <span className={styles.spinner}></span>}
                    </button>

                    {config.vendorSelections[vendor] && (
                        <select
                            value={config.vendorSelections[vendor]}
                            onChange={e => setVendorModel(vendor, e.target.value)}
                            className={styles.modelSelect}
                            disabled={vendorModels[vendor].loading}
                        >
                            {vendorModels[vendor].models.map(model => (
                                <option key={model} value={model}>
                                    {model}
                                </option>
                            ))}
                        </select>
                    )}

                    {vendorModels[vendor].error && (
                        <span className={styles.errorText}>{vendorModels[vendor].error}</span>
                    )}
                </div>
            ))}
        </div>
    )
}