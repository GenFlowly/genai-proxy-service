import React, { useState, useEffect } from 'react'
import PromptEditor from '../../PromptEditorWidget/PromptEditor'
import MultiPurposeButton from '../../../common/MultiPurposeButton/MultiPurposeButton'
import styles from './PlainNotes.module.scss'
import { useAuth } from '../../../../context/AuthContext'
import { useNotes } from '../../../../context/NotesContext'
import { saveNote } from '../../../../services/saveNotesService'

export default function PlainNotes() {
    const { getAccessTokenSilently } = useAuth()
    const { activeNote, clearActiveNote } = useNotes()
    const [prompt, setPrompt] = useState('')
    const [isLoading, setIsLoading] = useState(false)

    // Load the note selected in the Saved Notes sidebar into the editor
    useEffect(() => {
        if (activeNote) {
            setPrompt(activeNote.noteValue)
        }
    }, [activeNote])

    const handleSave = async () => {
        try {
            setIsLoading(true)
            const token = await getAccessTokenSilently()
            await saveNote({
                // Reuse the key when editing an opened note so it updates instead of duplicating
                noteKey: activeNote?.noteKey ?? crypto.randomUUID(),
                noteValue: prompt,
                title: activeNote?.title,
                createdAt: activeNote?.createdAt ?? new Date().toISOString(),
                client: 'REACT_APP',
            }, token)
            console.log('Plain Note saved successfully')
            setPrompt('') // Optional: clear after save
            clearActiveNote()
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
                    height="auto"
                    maxLength={400000}
                    variant="seamless"
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
