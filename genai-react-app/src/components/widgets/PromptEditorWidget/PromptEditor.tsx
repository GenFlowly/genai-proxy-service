import React, { useEffect, useState, useRef } from 'react'
import { ICONS } from '../../../constants/icons'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor from '@uiw/react-markdown-editor'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import { useConversation } from '../../../context/ConversationContext'
import { useAI } from '../../../context/AIContext'
import styles from './PromptEditor.module.scss'
import { EditorView } from '@codemirror/view'
import { addStepsCommand, addExamplesCommand } from './CustomToolbarCommands'

interface PromptEditorProps {
    id: string
    value: string
    onChange: (value: string) => void
}

export default function PromptEditor({ id, value, onChange }: PromptEditorProps): React.ReactElement {
    const { setPrompt } = useAI()
    // Debounce refs
    const storageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const aiContextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const STORAGE_KEY = `prompt_editor_content_conv-${id}`

    // Load from localStorage only on mount if empty
    useEffect(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEY)
            if (saved && !value) {
                onChange(saved)
            }
        } catch (err) {
            console.error('Failed to load from localStorage:', err)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const handleChange = (newValue: string) => {
        // Immediate UI update via parent
        onChange(newValue)

        // Debounce localStorage
        if (storageTimerRef.current) clearTimeout(storageTimerRef.current)
        storageTimerRef.current = setTimeout(() => {
            try {
                localStorage.setItem(STORAGE_KEY, newValue)
            } catch (err) {
                console.error(err)
            }
        }, 500)

        // Debounce AI Context (Token Counting)
        if (aiContextTimerRef.current) clearTimeout(aiContextTimerRef.current)
        aiContextTimerRef.current = setTimeout(() => {
            setPrompt(newValue)
        }, 300)
    }

    // Cleanup timers
    useEffect(() => {
        return () => {
            if (storageTimerRef.current) clearTimeout(storageTimerRef.current)
            if (aiContextTimerRef.current) clearTimeout(aiContextTimerRef.current)
        }
    }, [])

    // Sync AI context on mount or external prop change?
    // Not strictly necessary for "typing lag" fix but good for consistency
    useEffect(() => {
        setPrompt(value)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return (
        <div className={styles.container}>
            <div className={styles.editorWrapper}>
                <div className={styles.innerContainer}>
                    {/* Ghost spacer for perfect centering */}
                    <div className={styles.spacer} />
                    <div className={styles.mdxEditorRoot}>
                        <MarkdownEditor
                            value={value}
                            onChange={(val) => handleChange(val)}
                            height="600px"
                            visible={false}
                            enablePreview={true}
                            className={styles.markdownEditor}
                            toolbars={[


                                addStepsCommand,
                                addExamplesCommand,
                                'ulist',
                                'olist',

                                'code',

                            ]}
                            extensions={[EditorView.lineWrapping]}
                        />
                    </div>
                    <div className={styles.controlsRow}>
                        <CopyToClipboard
                            content={value}
                            label="Copy Prompt"
                            icon={ICONS.COPY}
                            successDuration={2000}
                        />
                    </div>
                </div>
            </div>
        </div>
    )
}