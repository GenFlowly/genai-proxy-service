export interface OnboardingStepProps {
    /** Omitted on the first step. */
    onBack?: () => void
    /** Advances to the next step, or finishes the wizard on the last step. */
    onNext: () => void
    isLastStep: boolean
    /** True while the wizard itself is finishing (saving the completion flag). */
    finishing: boolean
}
