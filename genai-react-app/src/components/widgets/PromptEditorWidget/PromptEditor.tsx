import React, { useEffect, useState, useRef } from 'react'
import { ICONS } from '../../../constants/icons'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor from '@uiw/react-markdown-editor'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import styles from './PromptEditor.module.scss'
import { EditorView } from '@codemirror/view'
import { addStepsCommand, addExamplesCommand } from './CustomToolbarCommands'

interface PromptEditorProps {
    id: string
    value: string
    onChange: (value: string) => void
    disableCache?: boolean
}

export default function PromptEditor({ id, value, onChange, disableCache = false }: PromptEditorProps): React.ReactElement {
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
                            onChange={onChange}
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
            {/*<PromptEditorTooltip*/}
            {/*    visible={tooltipState.visible}*/}
            {/*    top={tooltipState.top}*/}
            {/*    left={tooltipState.left}*/}
            {/*    onMarkReusable={handleMarkReusable}*/}
            {/*/>*/}
        </div>
    )
}