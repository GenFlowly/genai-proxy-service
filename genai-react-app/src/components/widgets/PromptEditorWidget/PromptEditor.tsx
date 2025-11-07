import React, { useEffect, useState, useRef } from 'react'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor from '@uiw/react-markdown-editor'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import { useConversation } from '../../../context/ConversationContext'
import { useAI } from '../../../context/AIContext'
import styles from './PromptEditor.module.scss'
import { EditorView } from '@codemirror/view'

interface PromptEditorProps {
    id: string
}

export default function PromptEditor({ id }: PromptEditorProps): React.ReactElement {
    const { conversationBlockList, updateResponseInConversationBlock } = useConversation()
    const { setPrompt } = useAI()
    const block = conversationBlockList.find(b => b.conversationBlockId === id)
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const STORAGE_KEY = `prompt_editor_content_conv-${block?.conversationBlockId}`

    // Load markdown from localStorage only on initial mount
    useEffect(() => {
        if (!block) return
        try {
            const saved = localStorage.getItem(STORAGE_KEY)
            if (saved && !block.prompt) updateResponseInConversationBlock(id, saved)
        } catch (err) {
            console.error('Failed to load from localStorage:', err)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []) // Empty dependency array = runs only once on mount

    // Debounced save to localStorage (300ms after user stops typing)
    const handleChange = (value: string) => {
        // ✅ Update context immediately for token counting
        setPrompt(value)

        // ✅ Update conversation block immediately for UI
        updateResponseInConversationBlock(id, value)

        // ✅ Debounce localStorage to avoid blocking the thread
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current)
        }

        debounceTimerRef.current = setTimeout(() => {
            try {
                localStorage.setItem(STORAGE_KEY, value)
            } catch (err) {
                console.error('Failed to save to localStorage:', err)
            }
        }, 300) // Adjust delay as needed (300ms is reasonable)
    }

    // Cleanup timer on unmount
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current)
            }
        }
    }, [])

    // When block changes externally, sync to context
    useEffect(() => {
        if (block?.prompt) {
            setPrompt(block.prompt)
        }
    }, [block?.prompt, setPrompt])

    if (!block) return <></>

    return (
        <div className={styles.container}>
            <div className={styles.headerSection}>
                <CopyToClipboard
                    content={block.prompt}
                    label="Copy"
                    successDuration={2000}
                />
            </div>
            <div className={styles.editorWrapper}>
                <div className={styles.mdxEditorRoot}>
                    <MarkdownEditor
                        value={block.prompt}
                        onChange={(value) => handleChange(value)}
                        height="600px"
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
                        extensions={[EditorView.lineWrapping]}
                    />
                </div>
            </div>
        </div>
    )
}