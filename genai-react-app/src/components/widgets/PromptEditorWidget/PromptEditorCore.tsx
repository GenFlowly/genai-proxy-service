import React from 'react'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor, { fullscreen, preview } from '@uiw/react-markdown-editor'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import styles from './PromptEditor.module.scss'
import { addStepsCommand, addExamplesCommand, addCopyCommand } from './CustomToolbarCommands'

interface PromptEditorCoreProps {
    id: string
    value: string
    onChange: (value: string) => void
    disableCache?: boolean
    height?: string
    className?: string
    'data-testid'?: string
    readOnly?: boolean
}

export default function PromptEditorCore({ id, value, onChange, disableCache = false, height = "50vh", className = '', 'data-testid': testId, readOnly = false }: PromptEditorCoreProps): React.ReactElement {

    return (
        <div className={`${styles.container} ${className}`} data-testid={testId} style={height === '100%' ? { height: '100%' } : {}}>
            <div className={styles.editorWrapper} style={height === '100%' ? { height: '100%' } : {}}>
                <div className={styles.innerContainer} style={height === '100%' ? { height: '100%' } : {}}>
                    {/* Ghost spacer for perfect centering */}
                    <div className={styles.spacer} />
                    <div className={styles.mdxEditorRoot} style={height === '100%' ? { height: '100%', display: 'flex', flexDirection: 'column' } : {}}>
                        <MarkdownEditor
                            value={value}
                            onChange={onChange}
                            height={height}
                            visible={false}
                            enablePreview={true}
                            showToolbar={false}
                            className={styles.markdownEditor}
                            extensions={[
                                EditorView.lineWrapping,
                                ...(readOnly ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : [])
                            ]}
                        />
                    </div>
                    <div className={styles.controlsRow}>
                    </div>
                </div>
            </div>
        </div>
    )
}
