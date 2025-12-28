import React from 'react'
import { ICONS } from '../../../constants/icons'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor from '@uiw/react-markdown-editor'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import styles from './PromptEditor.module.scss'
import { addStepsCommand, addExamplesCommand } from './CustomToolbarCommands'

interface PromptEditorProps {
    id: string
    value: string
    onChange: (value: string) => void
    disableCache?: boolean
}

export default function PromptEditor({ id, value, onChange, disableCache = false }: PromptEditorProps): React.ReactElement {

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