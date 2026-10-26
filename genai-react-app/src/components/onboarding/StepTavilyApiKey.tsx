import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputTextWithHint } from '@genflowly/component-library'
import { useAuth } from '../../context/AuthContext'
import { getToolCredentialStatuses, storeToolCredentials } from '../../services/customerToolsService'
import { OnboardingStepShell } from './OnboardingStepShell'
import { OnboardingStepProps } from './OnboardingStep.types'

const WEB_SEARCH_TOOL_TYPE = 'WEB_SEARCH'
const AUTH_TYPE = 'api_key'

export function StepTavilyApiKey({ onBack, onNext, isLastStep, finishing }: OnboardingStepProps): React.ReactElement {
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
                const { toolCredentialStatuses } = await getToolCredentialStatuses(token)
                if (!cancelled) {
                    setAlreadyConfigured(
                        !!toolCredentialStatuses.find(s => s.toolType === WEB_SEARCH_TOOL_TYPE)?.connected
                    )
                }
            } catch (err) {
                console.error('StepTavilyApiKey: failed to fetch tool credential status', err)
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
            await storeToolCredentials(token, {
                toolType: WEB_SEARCH_TOOL_TYPE,
                authType: AUTH_TYPE,
                credentials: { api_key: key },
            })
            onNext()
        } catch (err) {
            setMessage(err instanceof Error ? err.message : t('onboarding.genericSaveError'))
            setMessageKind('error')
        } finally {
            setBusy(false)
        }
    }

    return (
        <OnboardingStepShell
            title={t('onboarding.tavily.title')}
            description={t('onboarding.tavily.description')}
            linkHref="https://app.tavily.com"
            linkLabel={t('onboarding.tavily.linkLabel')}
            onBack={onBack}
            onSkip={onNext}
            onContinue={() => void handleContinue()}
            continueLabel={isLastStep ? t('onboarding.finish') : t('onboarding.saveAndContinue')}
            busy={busy || finishing}
            message={alreadyConfigured ? t('onboarding.alreadyConfigured') : message}
            messageKind={alreadyConfigured ? 'success' : messageKind}
        >
            <InputTextWithHint
                hint={t('settingsPage.toolsSettings.builtInKeyHint')}
                type="password"
                placeholder={alreadyConfigured
                    ? t('settingsPage.toolsSettings.builtInKeyReplacePlaceholder')
                    : t('settingsPage.toolsSettings.builtInKeyPlaceholder')}
                value={keyInput}
                disabled={busy}
                onChange={e => setKeyInput(e.target.value)}
                data-testid="onboarding-tavily-key-input"
            />
        </OnboardingStepShell>
    )
}
