import React, { useState } from 'react'
import PromptEditor from '../../PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../../common/MultiPurposeButton/MultiPurposeButton'
import styles from './KeyValueNotes.module.scss'

export default function KeyValueNotes() {
    const [keyPrompt, setKeyPrompt] = useState('')
    const [valuePrompt, setValuePrompt] = useState('')

    const handleSave = () => {
        console.log('Save clicked', { key: keyPrompt, value: valuePrompt, mode: 'KEY_VALUE' })
    }

    return (
        <>
            <div className={styles.keyEditorWrapper}>
                <PromptEditor
                    id="notes-widget-key-editor"
                    value={keyPrompt}
                    onChange={setKeyPrompt}
                    height="100%"
                />
            </div>
            <div className={styles.valueEditorWrapper}>
                <PromptEditor
                    id="notes-widget-value-editor"
                    value={valuePrompt}
                    onChange={setValuePrompt}
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
