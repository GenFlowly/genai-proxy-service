import React, { useEffect, useState } from 'react'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import {
    getTextGenerationModels,
} from '../../../services/getTextGenerationModelsService'
import { CacheManager } from '../../../utils/cache'
import styles from './AIVendorWidget.module.scss'
import {
    GetTextGenerationModelsResponse
} from "../../../models/getTextGenerationModels.models";

interface Props {
    collapsed?: boolean
}

const modelCache = new CacheManager({
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    prefix: 'ai_models_',
})

function getCacheKey(vendor: AIVendor, customerId: string): string {
    return `${vendor}_${customerId}`
}

export default function AIVendorWidget({ collapsed = false }: Props): React.ReactElement {
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

    useEffect(() => {
        if (!customerId) return
        const updated = { ...vendorModels }
        vendors.forEach(vendor => {
            const cached = modelCache.get<GetTextGenerationModelsResponse>(getCacheKey(vendor, customerId))
            if (cached) updated[vendor].models = cached.modelsList
        })
        setVendorModels(updated)
    }, [customerId])

    useEffect(() => {
        const fetchModels = async () => {
            if (!isAuthenticated || !customerId) return
            try {
                const token = await getAccessTokenSilently()
                for (const vendor of vendors) {
                    setVendorModels(prev => ({
                        ...prev,
                        [vendor]: { ...prev[vendor], loading: true },
                    }))
                    try {
                        const res = await getTextGenerationModels(token, { vendor, customerId })
                        setVendorModels(prev => ({
                            ...prev,
                            [vendor]: { loading: false, models: res.modelsList },
                        }))
                    } catch (err) {
                        console.error(err)
                        setVendorModels(prev => ({
                            ...prev,
                            [vendor]: { loading: false, models: [], error: 'Failed to load' },
                        }))
                    }
                }
            } catch (err) {
                console.error('Model fetch error:', err)
            }
        }
        fetchModels()
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    // 💡 Compact collapsed view
    if (collapsed) {
        return (
            <div className={`${styles.vendorWidget} ${styles.collapsed}`}>
                {vendors.map(vendor => (
                    <button
                        key={vendor}
                        type="button"
                        className={`${styles.iconButton} ${
                            config.vendorSelections[vendor] ? styles.active : ''
                        }`}
                        onClick={() =>
                            setVendorModel(
                                vendor,
                                config.vendorSelections[vendor] ? null : vendorModels[vendor].models[0]
                            )
                        }
                        title={vendor}
                    >
                        {vendor[0]}
                    </button>
                ))}
            </div>
        )
    }

    // 🧱 Normal expanded view
    return (
        <div className={styles.vendorWidget}>
            <div className={styles.header}>
                <h3 className={styles.title}>AI Models</h3>
                <button
                    className={styles.refreshButton}
                    onClick={() => window.location.reload()}
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
                                config.vendorSelections[vendor] ? null : vendorModels[vendor].models[0]
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
