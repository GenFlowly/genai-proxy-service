import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import styles from './TextContainer.module.scss'

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
                    label="Copy"
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
    /** Optional header title */
    title?: string

    /** Markdown or plain text content */
    content: string

    /** Show a copy-to-clipboard button for the entire content */
    showCopyButton?: boolean

    /** Optional custom className override */
    className?: string
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
                                      }: TextContainerProps) {
    return (
        <article className={`${styles.article} ${className || ''}`}>
            {(title || showCopyButton) && (
                <header className={styles.header}>
                    <div className={styles.headerContent}>
                        {title && <h2>{title}</h2>}
                        {showCopyButton && (
                            <CopyToClipboard
                                content={content}
                                label="Copy"
                                successMessage="✓ Copied"
                                successDuration={2000}
                                size="sm"
                                variant="secondary"
                            />
                        )}
                    </div>
                </header>
            )}

            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                    pre: PreBlock,
                }}
            >
                {content}
            </ReactMarkdown>
        </article>
    )
}
