import React, { useState, useEffect, useCallback, useRef } from 'react'
import { TextEditor } from '@genflowly/component-library'
import styles from './KeyValueNotes.module.scss'
import { useAuth } from '../../../../context/AuthContext'
import { useNotes } from '../../../../context/NotesContext'
import { saveNote } from '../../../../services/saveNotesService'
import { useAutosave, AutosaveSaveOptions } from '../../../../hooks/useAutosave'

export default function KeyValueNotes() {
    const { getAccessTokenSilently } = useAuth()
    const { setSaveState } = useNotes()
    const [keyPrompt, setKeyPrompt] = useState('')
    const [valuePrompt, setValuePrompt] = useState('')

    // Only the value field drives autosave; the key is read at save time so
    // typing in the key field never fires half-typed keys at the backend
    const keyPromptRef = useRef(keyPrompt)
    keyPromptRef.current = keyPrompt
    const createdAtRef = useRef<string>(new Date().toISOString())

    const save = useCallback(async (content: string, options: AutosaveSaveOptions) => {
        const note = {
            noteKey: keyPromptRef.current,
            noteValue: content,
            createdAt: createdAtRef.current,
            client: 'REACT_APP',
        }
        const token = await getAccessTokenSilently()
        await saveNote(note, token, options)
    }, [getAccessTokenSilently])

    const { status, lastSavedAt, flush } = useAutosave({
        content: valuePrompt,
        save,
        enabled: keyPrompt.trim() !== '',
    })

    // Surface save progress in the notes header
    useEffect(() => {
        setSaveState(status, lastSavedAt)
    }, [status, lastSavedAt, setSaveState])

    return (
        <>
            <div className={styles.keyEditorWrapper}>
                <TextEditor
                    id="notes-widget-key-editor"
                    value={keyPrompt}
                    onChange={setKeyPrompt}
                    height="100%"
                    maxLength={400000}
                />
            </div>
            <div className={styles.valueEditorWrapper} onBlur={() => flush()}>
                <TextEditor
                    id="notes-widget-value-editor"
                    value={valuePrompt}
                    onChange={setValuePrompt}
                    height="100%"
                    maxLength={400000}
                />
            </div>
        </>
    )
}
