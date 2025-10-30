import React, { useEffect, useState } from 'react'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor from '@uiw/react-markdown-editor'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import { useConversation } from '../../../context/ConversationContext'
import styles from './PromptEditor.module.scss'

interface PromptEditorProps {
    id: string
}

export default function PromptEditor({ id }: PromptEditorProps): React.ReactElement {
    const { conversations, updateMarkdown } = useConversation()
    const block = conversations.find(b => b.id === id)

    const STORAGE_KEY = `prompt_editor_content_${id}`

    // Load markdown from localStorage on mount
    useEffect(() => {
        if (!block) return
        try {
            const saved = localStorage.getItem(STORAGE_KEY)
            if (saved && !block.markdown) updateMarkdown(id, saved)
        } catch (err) {
            console.error('Failed to load from localStorage:', err)
        }
    }, [id, block, updateMarkdown])

    // Save markdown to localStorage whenever it changes
    const handleChange = (value: string) => {
        updateMarkdown(id, value)
        try {
            localStorage.setItem(STORAGE_KEY, value)
        } catch (err) {
            console.error('Failed to save to localStorage:', err)
        }
    }

    if (!block) return <></>

    return (
        <div className={styles.container}>
            <div className={styles.headerSection}>
                <label className={styles.label}>Prompt</label>
                <CopyToClipboard
                    content={block.markdown}
                    label="Copy"
                    successDuration={2000}
                />
            </div>
            <div className={styles.editorWrapper}>
                <div className={styles.mdxEditorRoot}>
                    <MarkdownEditor
                        value={block.markdown}
                        onChange={(value) => handleChange(value)}
                        height={"600px"}
                        visible={false}
                        enablePreview={true}
                        className={styles.markdownEditor}
                        toolbars={[
                            'bold',
                            'italic',
                            'underline',
                            'strike',
                            'header',
                            'quote',
                            'ulist',
                            'olist',
                            'todo',
                            'link',
                            'image',
                            'code',
                            'codeBlock',
                        ]}
                    />
                </div>
            </div>
        </div>
    )
}
