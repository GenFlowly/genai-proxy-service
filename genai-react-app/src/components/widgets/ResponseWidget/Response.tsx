import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import styles from './Response.module.scss'
import { AIVendor } from '../../../constants/vendors'
import { useLayout } from '../../../context/LayoutContext'

interface ResponseProps {
    responses: { vendor: AIVendor; text: string }[]
}

export default function Response({ responses }: ResponseProps) {
    const { isLeftVisible, isRightVisible } = useLayout()
    if (!responses || responses.length === 0) return null

    const sidebarsHidden = !isLeftVisible && !isRightVisible

    // Custom code block component with copy button
    const CodeBlock = ({ node, inline, className, children, ...props }: any) => {
        if (inline) {
            return <code className={className} {...props}>{children}</code>
        }

        // Recursively extract all text from AST nodes
        const extractText = (nodes: any[]): string => {
            return nodes
                .map((node: any) => {
                    if (node.value) return node.value
                    if (node.children) return extractText(node.children)
                    return ''
                })
                .join('')
        }

        const codeString = node?.children
            ? extractText(node.children).replace(/\n$/, '')
            : String(children).replace(/\n$/, '')
        const language = className?.replace('language-', '') || ''

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
                <pre className={className} {...props}>
                    <code>{children}</code>
                </pre>
            </div>
        )
    }

    return (
        <div className={styles.container}>
            <div
                className={`${styles.inner} ${
                    sidebarsHidden ? styles.sideBySide : ''
                }`}
            >
                {responses.map(({ vendor, text }) => (
                    <article key={vendor} className={styles.article}>
                        <header className={styles.header}>
                            <div className={styles.headerContent}>
                                <h2>{vendor}</h2>
                                <CopyToClipboard
                                    content={text}
                                    label="Copy"
                                    successMessage="✓ Copied"
                                    successDuration={2000}
                                    size="sm"
                                    variant="secondary"
                                />
                            </div>
                        </header>
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeHighlight]}
                            components={{
                                code: CodeBlock,
                            }}
                        >
                            {text}
                        </ReactMarkdown>
                    </article>
                ))}
            </div>
        </div>
    )
}