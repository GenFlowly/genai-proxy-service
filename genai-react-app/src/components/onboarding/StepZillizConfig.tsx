import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputTextWithHint } from '@genflowly/component-library'
import { useAuth } from '../../context/AuthContext'
import { VectorDBConfigStatusValue } from '../../models/storeCustomerVectorDBConfig.models'
import { storeCustomerVectorDBConfig } from '../../services/storeCustomerVectorDBConfigService'
import { OnboardingStepShell } from './OnboardingStepShell'
import { OnboardingStepProps } from './OnboardingStep.types'

// Same validation as the Settings page's Zilliz card (DatabaseConnectionsSettingsWidget)
const ENDPOINT_REGEX = /^https:\/\/[a-zA-Z0-9-]+\.(?:serverless|dedicated)\.[a-zA-Z0-9-]+\.cloud\.zilliz\.com\/?$/i
const TOKEN_REGEX = /^[a-fA-F0-9]{64,}$/

export function StepZillizConfig({ onBack, onNext, isLastStep, finishing }: OnboardingStepProps): React.ReactElement {
    const { t } = useTranslation()
    const { getAccessTokenSilently, vectorDBConfigStatusList, updateVectorDBConfigStatus } = useAuth()

    const [endpoint, setEndpoint] = useState('')
    const [token, setToken] = useState('')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState<string | null>(null)
    const [messageKind, setMessageKind] = useState<'success' | 'error' | null>(null)

    const alreadyConfigured = vectorDBConfigStatusList.some(
        s => s.vendor === 'Zilliz' && s.status === VectorDBConfigStatusValue.PRESENT
    )

    const handleContinue = async () => {
        const endpointValue = endpoint.trim()
        const tokenValue = token.trim()
        if (!endpointValue && !tokenValue) {
            onNext()
            return
        }
        if (!ENDPOINT_REGEX.test(endpointValue)) {
            setMessage(t('onboarding.zilliz.invalidEndpoint'))
            setMessageKind('error')
            return
        }
        if (!TOKEN_REGEX.test(tokenValue)) {
            setMessage(t('onboarding.zilliz.invalidToken'))
            setMessageKind('error')
            return
        }
        setBusy(true)
        setMessage(null)
        try {
            const accessToken = await getAccessTokenSilently()
            const response = await storeCustomerVectorDBConfig(accessToken, {
                vendor: 'Zilliz',
                endpoint: endpointValue,
                token: tokenValue,
            })
            if (response.configStatus?.updateSuccessful) {
                updateVectorDBConfigStatus(response.configStatus)
                onNext()
            } else {
                setMessage(t('onboarding.genericSaveError'))
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
            title={t('onboarding.zilliz.title')}
            description={t('onboarding.zilliz.description')}
            linkHref="https://cloud.zilliz.com"
            linkLabel={t('onboarding.zilliz.linkLabel')}
            onBack={onBack}
            onSkip={onNext}
            onContinue={() => void handleContinue()}
            continueLabel={isLastStep ? t('onboarding.finish') : t('onboarding.saveAndContinue')}
            busy={busy || finishing}
            message={alreadyConfigured ? t('onboarding.alreadyConfigured') : message}
            messageKind={alreadyConfigured ? 'success' : messageKind}
        >
            <InputTextWithHint
                hint={t('dbSettings.databaseConnectionsSettingsWidget.endpointHint')}
                value={endpoint}
                disabled={busy}
                onChange={e => setEndpoint(e.target.value)}
                placeholder={t('dbSettings.databaseConnectionsSettingsWidget.zillizEndpointPlaceholder')}
                data-testid="onboarding-zilliz-endpoint-input"
            />
            <InputTextWithHint
                hint={t('dbSettings.databaseConnectionsSettingsWidget.tokenHint')}
                type="password"
                value={token}
                disabled={busy}
                onChange={e => setToken(e.target.value)}
                placeholder={t('dbSettings.databaseConnectionsSettingsWidget.zillizTokenPlaceholder')}
                data-testid="onboarding-zilliz-token-input"
            />
        </OnboardingStepShell>
    )
}
