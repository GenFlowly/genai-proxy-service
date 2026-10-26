import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputTextWithHint } from '@genflowly/component-library'
import { useAuth } from '../../context/AuthContext'
import { APIKeyStatus } from '../../models/storeCustomerVendorAPIKeys.models'
import { EmbeddingVendor, getEmbeddingKeys, storeEmbeddingKey } from '../../services/embeddingKeysService'
import { OnboardingStepShell } from './OnboardingStepShell'
import { OnboardingStepProps } from './OnboardingStep.types'

export function StepVoyageApiKey({ onBack, onNext, isLastStep, finishing }: OnboardingStepProps): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    const [keyInput, setKeyInput] = useState('')
    const [alreadyConfigured, setAlreadyConfigured] = useState(false)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState<string | null>(null)
    const [messageKind, setMessageKind] = useState<'success' | 'error' | null>(null)

    useEffect(() => {
        if (!isAuthenticated) return
        let cancelled = false
        void (async () => {
            try {
                const token = await getAccessTokenSilently()
                const response = await getEmbeddingKeys(token)
                const status = response.statuses.find(s => s.vendor === EmbeddingVendor.VOYAGE)
                if (!cancelled) {
                    setAlreadyConfigured(status?.status === APIKeyStatus.VALID || !!status?.isAPIKeyValid)
                }
            } catch (err) {
                console.error('StepVoyageApiKey: failed to fetch embedding key status', err)
            }
        })()
        return () => { cancelled = true }
    }, [isAuthenticated, getAccessTokenSilently])

    const handleContinue = async () => {
        const key = keyInput.trim()
        if (!key) {
            onNext()
            return
        }
        setBusy(true)
        setMessage(null)
        try {
            const token = await getAccessTokenSilently()
            const response = await storeEmbeddingKey(token, EmbeddingVendor.VOYAGE, key)
            if (response.keyStatus.updateSuccessful) {
                onNext()
            } else {
                setMessage(response.keyStatus.detail || response.keyStatus.status)
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
            title={t('onboarding.voyage.title')}
            description={t('onboarding.voyage.description')}
            linkHref="https://dash.voyageai.com/api-keys"
            linkLabel={t('onboarding.voyage.linkLabel')}
            onBack={onBack}
            onSkip={onNext}
            onContinue={() => void handleContinue()}
            continueLabel={isLastStep ? t('onboarding.finish') : t('onboarding.saveAndContinue')}
            busy={busy || finishing}
            message={alreadyConfigured ? t('onboarding.alreadyConfigured') : message}
            messageKind={alreadyConfigured ? 'success' : messageKind}
        >
            <InputTextWithHint
                hint={t('settingsPage.embeddingKeysSettings.voyageLabel')}
                type="password"
                placeholder={alreadyConfigured
                    ? t('settingsPage.aiSettings.overwriteApiKey')
                    : t('onboarding.voyage.keyPlaceholder')}
                value={keyInput}
                disabled={busy}
                onChange={e => setKeyInput(e.target.value)}
                data-testid="onboarding-voyage-key-input"
            />
        </OnboardingStepShell>
    )
}
