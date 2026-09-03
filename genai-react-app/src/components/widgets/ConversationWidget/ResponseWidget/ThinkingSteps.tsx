import React from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Brain, FileSearch, Globe, LucideIcon, Sparkles } from 'lucide-react'
import { ThinkingStep, ThinkingStepKind } from '../../../../models/conversation.models'
import styles from './ThinkingSteps.module.scss'

const KIND_ICONS: Record<ThinkingStepKind, LucideIcon> = {
    LLM: Brain,
    MEMORY: BookOpen,
    RETRIEVAL: FileSearch,
    WEB_SEARCH: Globe,
    REFLECTION: Sparkles,
}

/** Collapsed-by-default monospace block for a step's prompt or raw response. */
function StepExpander({ label, text, testId }: { label: string, text: string, testId: string }) {
    return (
        <details className={styles.expander} data-testid={testId}>
            <summary className={styles.expanderSummary}>{label}</summary>
            <pre className={styles.expanderContent}>{text}</pre>
        </details>
    )
}

/**
 * Structured per-node steps of the agent graph's thinking phase, in arrival
 * order. Running steps show their live label with a pulse; finished ones show
 * the node name, a detail line, retrieved items, and (for LLM-backed nodes)
 * prompt/response expanders.
 */
export default function ThinkingSteps({ steps }: { steps: ThinkingStep[] }) {
    const { t } = useTranslation()

    if (steps.length === 0) return null

    return (
        <ol className={styles.steps} data-testid="thinking-step-list">
            {steps.map((step, i) => {
                const isRunning = step.status === 'running'
                // A known kind gets its icon; legacy flat strings have none
                const KindIcon = step.kind ? KIND_ICONS[step.kind] : undefined
                const heading = isRunning ? (step.label || step.name) : step.name

                return (
                    <li
                        // Cycles legitimately repeat a node id — suffix with the
                        // position; the list is append-only so this stays stable
                        key={`${step.node}-${i}`}
                        className={styles.step}
                        data-testid="thinking-step"
                        data-status={step.status}
                    >
                        <span className={styles.stepHeader}>
                            {KindIcon && <KindIcon className={styles.kindIcon} size={14} aria-hidden="true" />}
                            {isRunning && <span className={styles.pulse} data-testid="thinking-step-pulse" />}
                            <span className={styles.stepName}>{heading}</span>
                        </span>
                        {!isRunning && step.detail && (
                            <span className={styles.detail}>{step.detail}</span>
                        )}
                        {!isRunning && step.items && step.items.length > 0 && (
                            <ul className={styles.items} data-testid="thinking-step-items">
                                {step.items.map((item, j) => <li key={j}>{item}</li>)}
                            </ul>
                        )}
                        {!isRunning && step.prompt && (
                            <StepExpander
                                label={t('conversation.response.thinkingPrompt')}
                                text={step.prompt}
                                testId="thinking-step-prompt"
                            />
                        )}
                        {!isRunning && step.response && (
                            <StepExpander
                                label={t('conversation.response.thinkingResponse')}
                                text={step.response}
                                testId="thinking-step-response"
                            />
                        )}
                    </li>
                )
            })}
        </ol>
    )
}
