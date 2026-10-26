import React from 'react'
import { useTranslation } from 'react-i18next'
import { PillButton } from '@genflowly/component-library'
import { ICONS } from '../../constants/icons'
import styles from './OnboardingStepShell.module.scss'

export interface OnboardingStepShellProps {
    title: string
    description: string
    linkHref: string
    linkLabel: string
    onBack?: () => void
    onSkip: () => void
    onContinue: () => void
    continueLabel: string
    continueDisabled?: boolean
    busy?: boolean
    message?: string | null
    messageKind?: 'success' | 'error' | null
    children: React.ReactNode
}

/** Shared chrome for one onboarding screen: title/description/link, the
 * credential input(s), an inline message, and the Back/Skip/Continue row. */
export function OnboardingStepShell({
    title,
    description,
    linkHref,
    linkLabel,
    onBack,
    onSkip,
    onContinue,
    continueLabel,
    continueDisabled,
    busy,
    message,
    messageKind,
    children,
}: OnboardingStepShellProps): React.ReactElement {
    const { t } = useTranslation()
    return (
        <div className={styles.step} data-testid="onboarding-step">
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.description}>{description}</p>
            <a
                href={linkHref}
                target="_blank"
                rel="noreferrer noopener"
                className={styles.link}
                data-testid="onboarding-step-link"
            >
                {linkLabel}
            </a>
            <div className={styles.body}>{children}</div>
            {message && (
                <p
                    className={messageKind === 'error' ? styles.errorMessage : styles.successMessage}
                    data-testid="onboarding-step-message"
                >
                    {message}
                </p>
            )}
            <div className={styles.footer}>
                {onBack ? (
                    <PillButton
                        variant="secondary"
                        icon={ICONS.ALT_ARROW_LEFT}
                        label={t('onboarding.back')}
                        onClick={onBack}
                        disabled={busy}
                        data-testid="onboarding-back"
                    />
                ) : <span />}
                <div className={styles.footerRight}>
                    <PillButton
                        variant="secondary"
                        label={t('onboarding.skipStep')}
                        onClick={onSkip}
                        disabled={busy}
                        data-testid="onboarding-skip-step"
                    />
                    <PillButton
                        label={continueLabel}
                        icon={ICONS.ALT_ARROW_RIGHT}
                        onClick={onContinue}
                        disabled={busy || continueDisabled}
                        data-testid="onboarding-continue"
                    />
                </div>
            </div>
        </div>
    )
}
