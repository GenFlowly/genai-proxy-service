import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import styles from './TextContainer.module.scss'
import { ICONS } from '../../../constants/icons'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName
} from '../../common/BrandName/BrandName'
import { AIVendor } from '../../../constants/vendors'

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
    /** Optional header title, ignored if aiVendor is set */
    title?: string

    /** Optional AI Vendor to render specific brand header */
    aiVendor?: string

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
 * - Optional title header or AI Brand header
 */
export default function TextContainer({
    title,
    aiVendor,
    content,
    showCopyButton = true,
    className,
}: TextContainerProps) {

    let HeaderComponent: React.ReactNode = null
    if (aiVendor) {
        if (aiVendor === AIVendor.OPENAI) HeaderComponent = <OpenAIBrandName as="span" />
        else if (aiVendor === AIVendor.CLAUDE) HeaderComponent = <ClaudeBrandName as="span" />
        else if (aiVendor === AIVendor.GEMINI) HeaderComponent = <GeminiBrandName as="span" />
        else HeaderComponent = <h2>{aiVendor}</h2> // Fallback if unknown vendor string
    } else if (title) {
        HeaderComponent = <h2>{title}</h2>
    }

    return (
        <article className={`${styles.article} ${className || ''}`}>
            {(HeaderComponent || showCopyButton) && (
                <header className={styles.header}>
                    <div className={styles.headerContent}>
                        {HeaderComponent}
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
