import React, { useState } from 'react'
import PromptEditor from '../../PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../../common/MultiPurposeButton/MultiPurposeButton'
import styles from './KeyValueNotes.module.scss'
import { useAuth } from '../../../../context/AuthContext'
import { saveNote } from '../../../../services/saveNotesService'

export default function KeyValueNotes() {
    const { getAccessTokenSilently } = useAuth()
    const [keyPrompt, setKeyPrompt] = useState('')
    const [valuePrompt, setValuePrompt] = useState('')
    const [isLoading, setIsLoading] = useState(false)

    const handleSave = async () => {
        try {
            setIsLoading(true)
            const token = await getAccessTokenSilently()
            await saveNote({
                noteKey: keyPrompt,
                noteValue: valuePrompt,
                createdAt: new Date().toISOString(),
                client: 'REACT_APP',
            }, token)
            console.log('Key Value Note saved successfully')
            setKeyPrompt('')
            setValuePrompt('')
        } catch (error) {
            console.error('Failed to save key value note:', error)
        } finally {
            setIsLoading(false)
        }
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
                    disabled={isLoading}
                />
            </div>
        </>
    )
}
