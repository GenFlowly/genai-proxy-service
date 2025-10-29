import React, { useEffect, useState } from 'react'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { getTextGenerationModels } from '../../../services/modelService'
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

    const vendors = Object.values(AIVendor) as AIVendor[] // ✅ critical fix

    useEffect(() => {
        if (!isAuthenticated || !customerId) return

        const fetchModels = async () => {
            try {
                const token = await getAccessTokenSilently()
                for (const vendor of vendors) {
                    setVendorModels(prev => ({
                        ...prev,
                        [vendor]: { ...prev[vendor], loading: true },
                    }))

                    try {
                        const res = await getTextGenerationModels(token, {
                            vendor, // ✅ now correctly typed
                            customerId,
                        })
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

        fetchModels()
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    return (
        <div className={styles.vendorWidget}>
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
                    >
                        {vendor}
                    </button>

                    {config.vendorSelections[vendor] && (
                        <select
                            value={config.vendorSelections[vendor]}
                            onChange={e => setVendorModel(vendor, e.target.value)}
                            className={styles.modelSelect}
                        >
                            {vendorModels[vendor].models.map(model => (
                                <option key={model} value={model}>
                                    {model}
                                </option>
                            ))}
                        </select>
                    )}
                </div>
            ))}
        </div>
    )
}
