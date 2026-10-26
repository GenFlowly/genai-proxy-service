import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputSelectWithHint, InputTextWithHint, SelectOption } from '@genflowly/component-library'
import { useAuth } from '../../context/AuthContext'
import { useVendorDisplayNames } from '../../hooks/useVendorDisplayNames'
import { AIVendor, storedVendorId } from '../../constants/vendors'
import { APIKeyStatus } from '../../models/storeCustomerVendorAPIKeys.models'
import { storeCustomerVendorApiKey } from '../../services/storeCustomerVendorApiKeysService'
import { getProviderCatalog, ProviderInfo } from '../../services/providerCatalogService'
import { OnboardingStepShell } from './OnboardingStepShell'
import { OnboardingStepProps } from './OnboardingStep.types'

const SETUP_URL_BY_CATALOG_ID: Record<string, string> = {
    openai: 'https://platform.openai.com/api-keys',
    anthropic: 'https://console.anthropic.com/settings/keys',
}
const DEFAULT_SETUP_URL = 'https://platform.openai.com/api-keys'

export function StepLlmApiKey({ onBack, onNext, isLastStep, finishing }: OnboardingStepProps): React.ReactElement {
    const { t } = useTranslation()
    const {
        isAuthenticated,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList,
        updateVendorApiKeyStatus,
    } = useAuth()
    const vendorDisplayName = useVendorDisplayNames()

    const [catalog, setCatalog] = useState<ProviderInfo[]>([])
    const [vendor, setVendor] = useState('')
    const [keyInput, setKeyInput] = useState('')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState<string | null>(null)
    const [messageKind, setMessageKind] = useState<'success' | 'error' | null>(null)

    useEffect(() => {
        if (!isAuthenticated) return
        let cancelled = false
        void (async () => {
            try {
                const token = await getAccessTokenSilently()
                const response = await getProviderCatalog(token)
                if (!cancelled) setCatalog(response.providers)
            } catch (err) {
                console.error('StepLlmApiKey: failed to fetch provider catalog', err)
            }
        })()
        return () => { cancelled = true }
    }, [isAuthenticated, getAccessTokenSilently])

    const alreadyConfigured = aiVendorAPIKeyStatusList.some(
        s => s.status === APIKeyStatus.VALID || s.isAPIKeyValid
    )

    const vendorOptions: SelectOption[] = useMemo(() => {
        if (catalog.length > 0) {
            return catalog.map(p => ({ label: p.displayName, value: storedVendorId(p.id) }))
        }
        return (Object.values(AIVendor) as string[]).map(v => ({ label: vendorDisplayName(v), value: v }))
    }, [catalog, vendorDisplayName])

    const setupUrl = useMemo(() => {
        const provider = catalog.find(p => storedVendorId(p.id) === vendor)
        return (provider && SETUP_URL_BY_CATALOG_ID[provider.id]) || DEFAULT_SETUP_URL
    }, [catalog, vendor])

    const handleContinue = async () => {
        const key = keyInput.trim()
        if (!key) {
            onNext()
            return
        }
        if (!vendor) {
            setMessage(t('onboarding.llm.pickVendorError'))
            setMessageKind('error')
            return
        }
        setBusy(true)
        setMessage(null)
        try {
            const token = await getAccessTokenSilently()
            const response = await storeCustomerVendorApiKey(token, { aiVendor: vendor, apiKey: key })
            if (response.apiKeyStatus.updateSuccessful) {
                updateVendorApiKeyStatus(response.apiKeyStatus)
                onNext()
            } else {
                setMessage(response.apiKeyStatus.detail || response.apiKeyStatus.status)
                setMessageKind('error')
            }
        } catch (err) {
            setMessage(err instanceof Error ? err.message : t('onboarding.genericSaveError'))
            setMessageKind('error')
        } finally {
            setBusy(false)
        }
    }

    return (
        <OnboardingStepShell
            title={t('onboarding.llm.title')}
            description={t('onboarding.llm.description')}
            linkHref={setupUrl}
            linkLabel={t('onboarding.llm.linkLabel')}
            onBack={onBack}
            onSkip={onNext}
            onContinue={() => void handleContinue()}
            continueLabel={isLastStep ? t('onboarding.finish') : t('onboarding.saveAndContinue')}
            continueDisabled={!!keyInput.trim() && !vendor}
            busy={busy || finishing}
            message={alreadyConfigured ? t('onboarding.alreadyConfigured') : message}
            messageKind={alreadyConfigured ? 'success' : messageKind}
        >
            <InputSelectWithHint
                hint={t('onboarding.llm.vendorHint')}
                value={vendor}
                onChange={setVendor}
                options={vendorOptions}
                data-testid="onboarding-llm-vendor-select"
            />
            <InputTextWithHint
                hint={t('onboarding.llm.keyHint')}
                type="password"
                placeholder={alreadyConfigured
                    ? t('settingsPage.aiSettings.overwriteApiKey')
                    : t('onboarding.llm.keyPlaceholder')}
                value={keyInput}
                disabled={busy}
                onChange={e => setKeyInput(e.target.value)}
                data-testid="onboarding-llm-key-input"
            />
        </OnboardingStepShell>
    )
}
