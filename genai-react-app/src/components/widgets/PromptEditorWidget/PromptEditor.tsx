import React from 'react'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor, { fullscreen, preview } from '@uiw/react-markdown-editor'
import { EditorView } from '@codemirror/view'
import styles from './PromptEditor.module.scss'
import { addStepsCommand, addExamplesCommand, addCopyCommand } from './CustomToolbarCommands'

interface PromptEditorProps {
    id: string
    value: string
    onChange: (value: string) => void
    disableCache?: boolean
    height?: string
    className?: string
    'data-testid'?: string
}

export default function PromptEditor({ id, value, onChange, disableCache = false, height = "40.25rem", className = '', 'data-testid': testId }: PromptEditorProps): React.ReactElement {

    return (
        <div className={`${styles.container} ${className}`} data-testid={testId}>
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
                            className={styles.markdownEditor}
                            toolbars={[


                                addStepsCommand,
                                addExamplesCommand,
                            ]}
                            toolbarsMode={[
                                preview,
                                fullscreen,
                                addCopyCommand,
                            ]}
                            extensions={[EditorView.lineWrapping]}
                        />
                    </div>
                    <div className={styles.controlsRow}>
                    </div>
                </div>
            </div>
        </div>
    )
}