import React, { useEffect } from 'react'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor from '@uiw/react-markdown-editor'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import { useConversation } from '../../../context/ConversationContext'
import styles from './PromptEditor.module.scss'

const STORAGE_KEY = 'prompt_editor_content'

export default function PromptEditor(): React.ReactElement {
    const { markdown, setMarkdown } = useConversation()

    // Load from localStorage on mount
    useEffect(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEY)
            if (saved) {
                setMarkdown(saved)
            }
        } catch (err) {
            console.error('Failed to load from localStorage:', err)
        }
    }, [setMarkdown])

    // Save to localStorage whenever markdown changes
    const handleChange = (value: string) => {
        setMarkdown(value)
        try {
            localStorage.setItem(STORAGE_KEY, value)
        } catch (err) {
            console.error('Failed to save to localStorage:', err)
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerSection}>
                <label className={styles.label}>Prompt</label>
                <CopyToClipboard content={markdown} label="Copy" successDuration={2000} />
            </div>
            <div className={styles.editorWrapper}>
                <div className={styles.mdxEditorRoot}>
                    <MarkdownEditor
                        value={markdown}
                        onChange={(value) => handleChange(value)}
                        height="400px"
                        visible={true}
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