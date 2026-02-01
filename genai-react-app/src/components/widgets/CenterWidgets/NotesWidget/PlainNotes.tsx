import React, { useState } from 'react'
import PromptEditor from '../../PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../../common/MultiPurposeButton/MultiPurposeButton'
import styles from './PlainNotes.module.scss'

export default function PlainNotes() {
    const [prompt, setPrompt] = useState('')

    const handleSave = () => {
        console.log('Save clicked', { prompt, mode: 'PLAIN' })
    }

    return (
        <>
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
        </>
    )
}
