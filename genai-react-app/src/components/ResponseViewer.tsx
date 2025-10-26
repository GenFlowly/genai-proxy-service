// src/components/ResponseViewer.tsx
import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'
import styles from './ResponseViewer.module.scss'
import { AIVendor } from '../constants/vendors'

interface ResponseViewerProps {
    responses: { vendor: AIVendor; text: string }[]
}

export default function ResponseViewer({ responses }: ResponseViewerProps) {
    if (responses.length === 0) return null

    return (
        <div className={styles.container}>
            <div className={styles.inner}>
                {responses.map(({ vendor, text }) => (
                    <article key={vendor} className={styles.article}>
                        <header className={styles.header}>
                            <h2>{vendor}</h2>
                        </header>
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeHighlight]}
                        >
                            {text}
                        </ReactMarkdown>
                    </article>
                ))}
            </div>
        </div>
    )
}
