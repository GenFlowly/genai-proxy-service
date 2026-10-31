import React from 'react'
import { useTranslation } from 'react-i18next'
import { AIVendor } from '../../../constants/vendors'
import { useAuth } from '../../../context/AuthContext'
import { useTextGenerationModels } from '../../../hooks/queries/useTextGenerationModels'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { PillButton } from '@genflowly/component-library'
import { VendorBrandName } from '../BrandName/BrandName'
import styles from './VendorModelSelect.module.scss'

const ALL_VENDORS = Object.values(AIVendor) as AIVendor[]

export interface VendorModelSelectProps {
    vendor: AIVendor | null
    model: string
    onChange: (vendor: AIVendor | null, model: string) => void
}

export default function VendorModelSelect({ vendor, model, onChange }: VendorModelSelectProps) {
    const { t } = useTranslation()
    const { aiVendorAPIKeyStatusList } = useAuth()

    // Same query/localStorage seed as AIVendorWidget — requests all vendors so
    // the picker can show models for any vendor the user may enable.
    const { data: modelsData } = useTextGenerationModels(ALL_VENDORS)
    const vendorModels = modelsData ?? []

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
                                label={<VendorBrandName vendorId={v} as="span" />}
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
