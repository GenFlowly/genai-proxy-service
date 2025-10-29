import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github.css'
import styles from './Response.module.scss'
import { useConversation } from '../../../context/ConversationContext'
import { useLayout } from '../../../context/LayoutContext'

export default function Response() {
    const { responses } = useConversation()
    const { isLeftVisible, isRightVisible } = useLayout()

    if (responses.length === 0) return null

    // When both sidebars are hidden → show side-by-side
    const sidebarsHidden = !isLeftVisible && !isRightVisible

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
