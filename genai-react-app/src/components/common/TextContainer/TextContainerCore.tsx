import React from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import styles from './TextContainer.module.scss'
import { ICONS } from '../../../constants/icons'

/**
 * Utility to recursively extract text from markdown AST nodes
 */
export const extractText = (nodes: any[]): string => {
    return nodes
        .map((node: any) => {
            if (node.value) return node.value
            if (node.children) return extractText(node.children)
            return ''
        })
        .join('')
}

/**
 * Custom <pre> block with copy-to-clipboard button for code snippets
 */
export const PreBlock = ({ node, children, ...props }: any) => {
    const { t } = useTranslation()
    const codeString = node?.children
        ? extractText(node.children).replace(/\n$/, '')
        : ''

    return (
        <div style={{ position: 'relative' }}>
            <div
                style={{
                    position: 'absolute',
                    top: '0.5rem',
                    right: '0.5rem',
                    zIndex: 10,
                }}
            >
                <CopyToClipboard
                    content={codeString}
                    label={t('common.textContainer.copyCode')}
                    icon={ICONS.COPY}
                    successMessage="✓"
                    successDuration={2000}
                    size="sm"
                    variant="secondary"
                />
            </div>
            <pre {...props}>{children}</pre>
        </div>
    )
}

export interface TextContainerCoreProps {
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

export default function TextContainerCore({
    title,
    content,
    showCopyButton = true,
    className,
    isLoading = false,
    children,
    'data-testid': testId,
    loadingContent,
    subheader
}: TextContainerCoreProps) {
    const { t } = useTranslation()

    const headerContent = (typeof title === 'string') ? <h2>{title}</h2> : title

    return (
        <article className={`${styles.article} ${className || ''}`} data-testid={testId}>
            {(headerContent || showCopyButton) && (
                <header className={styles.header} data-testid={testId ? `${testId}-header` : undefined}>
                    <div className={styles.headerContent}>
                        {headerContent}
                        {showCopyButton && (
                            <div className={styles.copyButtonPositioner}>
                                <CopyToClipboard
                                    content={content}
                                    label={t('common.textContainer.copyResponse')}
                                    icon={ICONS.COPY}
                                    successMessage="✓"
                                    successDuration={2000}
                                    size="sm"
                                    variant="secondary"
                                    data-testid={testId ? `${testId}-copy-button` : undefined}
                                />
                            </div>
                        )}
                    </div>
                </header>
            )}

            {subheader}

            {isLoading ? loadingContent : (
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                        pre: PreBlock,
                    }}
                >
                    {content}
                </ReactMarkdown>
            )}
            {children}
        </article>
    )
}
