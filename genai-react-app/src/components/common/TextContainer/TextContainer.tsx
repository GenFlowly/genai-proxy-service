import React, { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import styles from './TextContainer.module.scss'

const TextContainerCore = lazy(() => import('./TextContainerCore'))
export { extractText, PreBlock } from './TextContainerCore'

export interface TextContainerProps {
    title?: React.ReactNode
    content: string
    showCopyButton?: boolean
    className?: string
    isLoading?: boolean
    children?: React.ReactNode
    'data-testid'?: string
    loadingContent?: React.ReactNode
    /** Rendered between the header and the markdown content (e.g. a thinking summary) */
    subheader?: React.ReactNode
}

export default function TextContainer({
    title,
    content,
    showCopyButton = true,
    className,
    isLoading = false,
    children,
    'data-testid': testId,
    loadingContent,
    subheader
}: TextContainerProps) {
    const { t } = useTranslation()

    // Same fallback UX preserving structural padding layout
    const fallbackUI = (
        <article className={`${styles.article} ${className || ''}`} data-testid={testId}>
            <div style={{ color: 'var(--color-text-tertiary)', padding: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {t('common.textContainer.loadingContentRenderer')}
            </div>
        </article>
    )

    return (
        <Suspense fallback={fallbackUI}>
            <TextContainerCore
                title={title}
                content={content}
                showCopyButton={showCopyButton}
                className={className}
                isLoading={isLoading}
                children={children}
                data-testid={testId}
                loadingContent={loadingContent}
                subheader={subheader}
            />
        </Suspense>
    )
}
