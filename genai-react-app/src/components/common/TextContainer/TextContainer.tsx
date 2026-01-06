import React from 'react'
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
const extractText = (nodes: any[]): string => {
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
const PreBlock = ({ node, children, ...props }: any) => {
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
                    label="Copy Code"
                    icon={ICONS.COPY}
                    successMessage="✓ Copied"
                    successDuration={2000}
                    size="sm"
                    variant="secondary"
                />
            </div>
            <pre {...props}>{children}</pre>
        </div>
    )
}

export interface TextContainerProps {
    /** Optional header title or component */
    title?: React.ReactNode

    /** Markdown or plain text content */
    content: string

    /** Show a copy-to-clipboard button for the entire content */
    showCopyButton?: boolean

    /** Optional custom className override */
    className?: string

    /** Optional loading state */
    isLoading?: boolean

    /** Optional children to render at the bottom (e.g. actions) */
    children?: React.ReactNode

    /** Optional test id */
    'data-testid'?: string

    /** Content to show when loading */
    loadingContent?: React.ReactNode
}

/**
 * Generic Markdown-rendering container card
 * - Supports code syntax highlighting
 * - Inline and block-level copy buttons
 * - Optional title header
 */
export default function TextContainer({
    title,
    content,
    showCopyButton = true,
    className,
    isLoading = false,
    children,
    'data-testid': testId,
    loadingContent
}: TextContainerProps) {

    // If title is a simple string, wrap it in h2 to maintain existing style
    // If it's a component (ReactNode), render as-is
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
                                    label="Copy Response"
                                    icon={ICONS.COPY}
                                    successMessage="✓ Copied"
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
