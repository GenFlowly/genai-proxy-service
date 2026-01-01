import React from 'react'
import { Icon } from '../Icon/Icon'
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
}: TextContainerProps) {

    // If title is a simple string, wrap it in h2 to maintain existing style
    // If it's a component (ReactNode), render as-is
    const headerContent = (typeof title === 'string') ? <h2>{title}</h2> : title

    return (
        <article className={`${styles.article} ${className || ''}`}>
            {(headerContent || showCopyButton) && (
                <header className={styles.header}>
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
                                />
                            </div>
                        )}
                    </div>
                </header>
            )}

            {isLoading ? (
                <div style={{ padding: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', opacity: 0.6, fontStyle: 'italic' }}>
                    <Icon src={ICONS.THINK} size={20} />
                    <span>Thinking...</span>
                </div>
            ) : (
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
