import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AIVendor } from '../../../constants/vendors'
import { useAuth } from '../../../context/AuthContext'
import { getTextGenerationModels } from '../../../services/getTextGenerationModelsService'
import { AIVendorModelList } from '../../../models/getTextGenerationModels.models'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { PillButton } from '@genflowly/component-library'
import { OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName } from '@genflowly/component-library'
import styles from './VendorModelSelect.module.scss'

const ALL_VENDORS = Object.values(AIVendor) as AIVendor[]

const BRAND_LABEL: Record<AIVendor, React.ReactNode> = {
    [AIVendor.OPENAI]: <OpenAIBrandName as="span" />,
    [AIVendor.CLAUDE]: <ClaudeBrandName as="span" />,
    [AIVendor.GEMINI]: <GeminiBrandName as="span" />,
}

export interface VendorModelSelectProps {
    vendor: AIVendor | null
    model: string
    onChange: (vendor: AIVendor | null, model: string) => void
}

export default function VendorModelSelect({ vendor, model, onChange }: VendorModelSelectProps) {
    const { t } = useTranslation()
    const { getAccessTokenSilently, customerId, isAuthenticated, aiVendorAPIKeyStatusList } = useAuth()
    const [vendorModels, setVendorModels] = useState<AIVendorModelList[]>([])

    const fetchModels = useCallback(async () => {
        if (!isAuthenticated || !customerId) return

        // Use the same localStorage cache as AIVendorWidget
        const cacheKey = `${customerId}_ai_vendor_models`
        const cached = localStorage.getItem(cacheKey)
        if (cached) {
            try {
                const parsed = JSON.parse(cached)
                if (Array.isArray(parsed) && parsed.length > 0) {
                    setVendorModels(parsed)
                    return
                }
            } catch { /* ignore malformed cache */ }
        }

        try {
            const token = await getAccessTokenSilently()
            const response = await getTextGenerationModels(token, customerId, { aiVendor: ALL_VENDORS })
            const data = response.aiVendorModelList || []
            setVendorModels(data)
            if (data.length > 0) {
                localStorage.setItem(cacheKey, JSON.stringify(data))
            }
        } catch (err) {
            console.error('VendorModelSelect: failed to fetch models', err)
        }
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    useEffect(() => {
        fetchModels()
    }, [fetchModels])

    const isVendorEnabled = (v: AIVendor) =>
        aiVendorAPIKeyStatusList.find(s => s.aiVendor === v)?.status === APIKeyStatus.VALID

    const getModels = (v: AIVendor): string[] =>
        vendorModels.find(vm => vm.aiVendor === v)?.modelsList ?? []

    const handleVendorClick = (v: AIVendor) => {
        if (!isVendorEnabled(v)) return
        if (vendor === v) {
            onChange(null, '')
        } else {
            const models = getModels(v)
            onChange(v, models[0] ?? '')
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.vendorRow}>
                {ALL_VENDORS.map(v => {
                    const enabled = isVendorEnabled(v)
                    const active = vendor === v
                    const status = aiVendorAPIKeyStatusList.find(s => s.aiVendor === v)
                    return (
                        <div key={v} className={styles.vendorBlock}>
                            <PillButton
                                label={BRAND_LABEL[v]}
                                onClick={() => handleVendorClick(v)}
                                disabled={!enabled}
                                variant={active ? 'primary' : 'secondary'}
                                data-testid={`vendor-select-${v}`}
                            />
                            {!enabled && (
                                <span className={styles.hint}>
                                    {status?.status ?? APIKeyStatus.NOT_SET}
                                </span>
                            )}
                        </div>
                    )
                })}
            </div>

            {vendor && isVendorEnabled(vendor) && (
                <div className={styles.modelRow}>
                    {getModels(vendor).length > 0 ? (
                        <select
                            className={styles.modelSelect}
                            value={model}
                            onChange={e => onChange(vendor, e.target.value)}
                            data-testid="agent-model-select"
                        >
                            {getModels(vendor).map(m => (
                                <option key={m} value={m}>{m}</option>
                            ))}
                        </select>
                    ) : (
                        <span className={styles.hint}>{t('common.vendorModelSelect.noModelsAvailable')}</span>
                    )}
                </div>
            )}
        </div>
    )
}
