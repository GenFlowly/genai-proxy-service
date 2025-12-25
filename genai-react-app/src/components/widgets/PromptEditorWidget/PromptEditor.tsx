import React, { useEffect, useState, useRef } from 'react'
import { ICONS } from '../../../constants/icons'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor from '@uiw/react-markdown-editor'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import styles from './PromptEditor.module.scss'
import { EditorView } from '@codemirror/view'
import { addStepsCommand, addExamplesCommand } from './CustomToolbarCommands'
import PromptEditorTooltip from './PromptEditorTooltip'

interface PromptEditorProps {
    id: string
    value: string
    onChange: (value: string) => void
}

export default function PromptEditor({ id, value, onChange }: PromptEditorProps): React.ReactElement {
    const { setPrompt, setActiveBlockId } = useAI()
    const { customerId } = useAuth()
    // Debounce refs
    const storageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const aiContextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const STORAGE_KEY = customerId ? `${customerId}_prompt_editor_content_conv-${id}` : ''

    // Load from localStorage only on mount if empty
    useEffect(() => {
        if (!STORAGE_KEY) return

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
        // Ensure we are the active block
        setActiveBlockId(id)

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
        setActiveBlockId(id)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Tooltip State
    const [tooltipState, setTooltipState] = useState<{
        visible: boolean
        top: number
        left: number
        text: string
    }>({ visible: false, top: 0, left: 0, text: '' })


    const handleEditorUpdate = React.useCallback((viewUpdate: any) => {
        if (viewUpdate.docChanged || viewUpdate.selectionSet) {
            const view = viewUpdate.view
            const { from, to } = view.state.selection.main

            if (from === to) {
                setTooltipState((prev) => ({ ...prev, visible: false }))
                return
            }

            const text = view.state.sliceDoc(from, to)
            // Get coordinates for the selection end
            const coords = view.coordsAtPos(to)

            if (coords) {
                setTooltipState({
                    visible: true,
                    top: coords.top,
                    left: coords.left,
                    text
                })
            }
        }
    }, [])

    const handleMarkReusable = async () => {
        // Dummy API call
        console.log('Marking as reusable:', tooltipState.text)
        setTooltipState((prev) => ({ ...prev, visible: false }))
    }

    const extensions = React.useMemo(() => [
        EditorView.lineWrapping,
        EditorView.updateListener.of(handleEditorUpdate)
    ], [handleEditorUpdate])

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
                            height="40.25rem"
                            visible={false}
                            enablePreview={true}
                            className={styles.markdownEditor}
                            toolbars={[


                                addStepsCommand,
                                addExamplesCommand,

                            ]}
                            extensions={extensions}
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

            {/* Tooltip Portal */}
            <PromptEditorTooltip
                visible={tooltipState.visible}
                top={tooltipState.top}
                left={tooltipState.left}
                onMarkReusable={handleMarkReusable}
            />
        </div>
    )
}