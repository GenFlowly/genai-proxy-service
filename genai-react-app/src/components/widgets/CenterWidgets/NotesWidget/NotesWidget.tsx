import React, { useState } from 'react'
import PromptEditor from '../../PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../../common/MultiPurposeButton/MultiPurposeButton'
import styles from './NotesWidget.module.scss'

export default function NotesWidget() {
    const [prompt, setPrompt] = useState('')

    const handleSave = () => {
        console.log('Save clicked', { prompt })
    }

    return (
        <div className={styles.container}>
            <div className={styles.editorWrapper}>
                <PromptEditor
                    id="notes-widget-editor"
                    value={prompt}
                    onChange={setPrompt}
                    height="100%"
                />
            </div>

            <div className={styles.actions}>
                <MultiPurposeButton
                    label="Save"
                    onClick={handleSave}
                />
            </div>
        </div>
    )
}
