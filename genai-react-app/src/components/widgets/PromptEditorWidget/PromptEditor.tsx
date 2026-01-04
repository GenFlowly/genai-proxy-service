import React from 'react'
import { ICONS } from '../../../constants/icons'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor from '@uiw/react-markdown-editor'
import { EditorView } from '@codemirror/view'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import styles from './PromptEditor.module.scss'
import { addStepsCommand, addExamplesCommand } from './CustomToolbarCommands'

interface PromptEditorProps {
    id: string
    value: string
    onChange: (value: string) => void
    disableCache?: boolean
    height?: string
    className?: string
}

export default function PromptEditor({ id, value, onChange, disableCache = false, height = "40.25rem", className = '' }: PromptEditorProps): React.ReactElement {

    return (
        <div className={`${styles.container} ${className}`}>
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