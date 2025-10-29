import React from 'react'
import '@uiw/react-markdown-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import MarkdownEditor from '@uiw/react-markdown-editor'
import CopyToClipboard from '../../common/CopyToClipboard/CopyToClipboard'
import { useConversation } from '../../../context/ConversationContext'
import styles from './PromptEditor.module.scss'

export default function PromptEditor(): React.ReactElement {
    const { markdown, setMarkdown } = useConversation()

    return (
        <div className={styles.container}>
            <div className={styles.headerSection}>
                <label className={styles.label}>Prompt</label>
                <CopyToClipboard content={markdown} label="Copy"  successDuration={2000}/>
            </div>
            <div className={styles.editorWrapper}>
                <div className={styles.mdxEditorRoot}>
                    <MarkdownEditor
                        value={markdown}
                        onChange={(value) => setMarkdown(value)}
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