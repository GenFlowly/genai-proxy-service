import React, { useState } from 'react'
import PromptEditor from '../../PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../../common/MultiPurposeButton/MultiPurposeButton'
import styles from './PlainNotes.module.scss'
import { useAuth } from '../../../../context/AuthContext'
import { saveNote } from '../../../../services/saveNotesService'

export default function PlainNotes() {
    const { getAccessTokenSilently } = useAuth()
    const [prompt, setPrompt] = useState('')
    const [isLoading, setIsLoading] = useState(false)

    const handleSave = async () => {
        try {
            setIsLoading(true)
            const token = await getAccessTokenSilently()
            await saveNote({
                noteKey: crypto.randomUUID(),
                noteValue: prompt,
                createdAt: new Date().toISOString(),
                client: 'REACT_APP',
            }, token)
            console.log('Plain Note saved successfully')
            setPrompt('') // Optional: clear after save
        } catch (error) {
            console.error('Failed to save plain note:', error)
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <>
            <div className={styles.editorWrapper}>
                <PromptEditor
                    id="notes-widget-editor"
                    value={prompt}
                    onChange={setPrompt}
                    height="100%"
                    maxLength={400000}
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
