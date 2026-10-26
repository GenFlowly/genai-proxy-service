import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PillButton } from '@genflowly/component-library'
import { OnboardingProgress } from './OnboardingProgress'
import { StepLlmApiKey } from './StepLlmApiKey'
import { StepZillizConfig } from './StepZillizConfig'
import { StepVoyageApiKey } from './StepVoyageApiKey'
import { StepTavilyApiKey } from './StepTavilyApiKey'
import styles from './OnboardingWizard.module.scss'

export interface OnboardingWizardProps {
    /** Persists onboarding-completed on the backend; rethrows on failure. */
    onDone: () => Promise<void>
}

const STEPS = [StepLlmApiKey, StepZillizConfig, StepVoyageApiKey, StepTavilyApiKey]

/**
 * One-time, full-screen setup flow shown in place of the whole app (see the
 * AppContent gate) until a brand-new account finishes or skips it. Not a
 * dismissible overlay — the only way out is "Skip setup" or completing step 4,
 * both of which call onDone().
 */
export function OnboardingWizard({ onDone }: OnboardingWizardProps): React.ReactElement {
    const { t } = useTranslation()
    const [stepIndex, setStepIndex] = useState(0)
    const [finishing, setFinishing] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const totalSteps = STEPS.length
    const isLastStep = stepIndex === totalSteps - 1
    const StepComponent = STEPS[stepIndex]

    const finish = async () => {
        setFinishing(true)
        setError(null)
        try {
            await onDone()
        } catch (err) {
            console.error('Failed to complete onboarding', err)
            setError(t('onboarding.completeError'))
        } finally {
            setFinishing(false)
        }
    }

    const handleNext = () => {
        if (isLastStep) {
            void finish()
        } else {
            setStepIndex(i => i + 1)
        }
    }

    const handleBack = () => setStepIndex(i => Math.max(0, i - 1))

    return (
        <div className={styles.overlay} data-testid="onboarding-wizard">
            <div className={styles.panel}>
                <div className={styles.header}>
                    <OnboardingProgress currentStep={stepIndex} totalSteps={totalSteps} />
                    <PillButton
                        variant="secondary"
                        label={t('onboarding.skipSetup')}
                        onClick={() => void finish()}
                        disabled={finishing}
                        data-testid="onboarding-skip-all"
                    />
                </div>
                <p className={styles.skipHint}>{t('onboarding.skipHint')}</p>
                <StepComponent
                    onBack={stepIndex > 0 ? handleBack : undefined}
                    onNext={handleNext}
                    isLastStep={isLastStep}
                    finishing={finishing}
                />
                {error && (
                    <p className={styles.error} data-testid="onboarding-complete-error">{error}</p>
                )}
            </div>
        </div>
    )
}
