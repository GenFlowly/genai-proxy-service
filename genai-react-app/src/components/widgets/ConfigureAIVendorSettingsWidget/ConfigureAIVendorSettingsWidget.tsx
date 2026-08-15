import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { storeCustomerVendorApiKey } from '../../../services/storeCustomerVendorApiKeysService'
import PillButton from '../../common/PillButton/PillButton'
import { ICONS } from '../../../constants/icons'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName
} from '../../common/BrandName/BrandName'
import { InputTextWithHint } from '../../common/InputTextWithHint/InputTextWithHint'
import { VendorAPIKeyStatus } from '../../common/VendorAPIKeyStatus/VendorAPIKeyStatus'
import { useToast } from '../../../context/ToastContext'
import styles from './ConfigureAIVendorSettingsWidget.module.scss'

export default function ConfigureAIVendorSettingsWidget(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, getAccessTokenSilently, isAuthenticated, updateVendorApiKeyStatus } = useAuth()
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
            showToast(t('vendorSettings.configureAIVendorSettingsWidget.pleaseLogInFirst'))
            return
        }

        const apiKey = apiKeys[vendor]
        if (!apiKey.trim()) {
            showToast(t('vendorSettings.configureAIVendorSettingsWidget.enterValidApiKey'))
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
            showToast(error.message || t('vendorSettings.configureAIVendorSettingsWidget.errorSavingApiKey'))
        } finally {
            setLoading(prev => ({ ...prev, [vendor]: false }))
        }
    }

    return (
        <div className={styles.card}>
            <h2 className={styles.title}>{t('vendorSettings.configureAIVendorSettingsWidget.title')}</h2>
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
                            <div>
                                <InputTextWithHint
                                    hint={t('vendorSettings.configureAIVendorSettingsWidget.apiKeyHint')}
                                    value={apiKeys[vendor]}
                                    onChange={e => handleChange(vendor, e.target.value)}
                                    placeholder={t('vendorSettings.configureAIVendorSettingsWidget.apiKeyPlaceholder')}
                                />
                            </div>
                            <PillButton
                                onClick={() => handleSave(vendor)}
                                label={loading[vendor] ? t('vendorSettings.configureAIVendorSettingsWidget.saving') : t('vendorSettings.configureAIVendorSettingsWidget.save')}
                                icon={ICONS.SAVE_ICON}
                                disabled={loading[vendor]}
                            />
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
