import React from 'react'
import { useTranslation } from 'react-i18next'
import styles from './OnboardingProgress.module.scss'

export interface OnboardingProgressProps {
    /** 0-indexed */
    currentStep: number
    totalSteps: number
}

export function OnboardingProgress({ currentStep, totalSteps }: OnboardingProgressProps): React.ReactElement {
    const { t } = useTranslation()
    return (
        <div className={styles.progress} data-testid="onboarding-progress">
            <div className={styles.segments}>
                {Array.from({ length: totalSteps }, (_, i) => (
                    <span key={i} className={i <= currentStep ? styles.segmentFilled : styles.segment} />
                ))}
            </div>
            <span className={styles.label}>
                {t('onboarding.stepLabel', { current: currentStep + 1, total: totalSteps })}
            </span>
        </div>
    )
}
