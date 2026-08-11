import React, { useState, useEffect, useCallback, useRef } from 'react'
import PromptEditor from '../../PromptEditorWidget/PromptEditor'
import styles from './PlainNotes.module.scss'
import { useAuth } from '../../../../context/AuthContext'
import { useNotes } from '../../../../context/NotesContext'
import { saveNote } from '../../../../services/saveNotesService'
import { useAutosave, AutosaveSaveOptions } from '../../../../hooks/useAutosave'

// crypto is unavailable in some test environments (older jsdom)
const newNoteKey = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `note-${Date.now()}-${Math.random().toString(36).slice(2)}`

export default function PlainNotes() {
    const { getAccessTokenSilently } = useAuth()
    const { activeNote, setSaveState, setNoteTitle, publishNoteUpdate } = useNotes()
    const [prompt, setPrompt] = useState('')

    // Stable identity for the whole editing session so every autosave updates
    // the same note instead of creating a new one per save
    const noteKeyRef = useRef<string>(newNoteKey())
    const createdAtRef = useRef<string>(new Date().toISOString())
    const titleRef = useRef<string | undefined>(undefined)

    const save = useCallback(async (content: string, options: AutosaveSaveOptions) => {
        // Capture the note identity before any await: flushing right before a
        // different note is opened must save under the note being flushed
        const note = {
            noteKey: noteKeyRef.current,
            noteValue: content,
            title: titleRef.current,
            createdAt: createdAtRef.current,
            client: 'REACT_APP',
        }
        const token = await getAccessTokenSilently()
        const result = await saveNote(note, token, options)

        // The server generates a title on the first encoded save; adopt it so
        // the header shows it and later saves carry it
        const title = result.title ?? note.title
        if (result.title && noteKeyRef.current === note.noteKey) {
            titleRef.current = result.title
            setNoteTitle(result.title)
        }
        publishNoteUpdate({
            noteKey: note.noteKey,
            noteValue: content,
            title: title ?? '',
            createdAt: note.createdAt,
            updatedAt: new Date().toISOString(),
        })
    }, [getAccessTokenSilently, setNoteTitle, publishNoteUpdate])

    const { status, lastSavedAt, flush, reset } = useAutosave({ content: prompt, save })

    // Surface save progress in the notes header
    useEffect(() => {
        setSaveState(status, lastSavedAt)
    }, [status, lastSavedAt, setSaveState])

    // Load the note selected in the Saved Notes sidebar into the editor
    useEffect(() => {
        if (activeNote) {
            flush()
            const realTitle =
                activeNote.title && activeNote.title !== 'Untitled' ? activeNote.title : undefined
            noteKeyRef.current = activeNote.noteKey
            createdAtRef.current = activeNote.createdAt
            titleRef.current = realTitle
            setNoteTitle(realTitle ?? null)
            setPrompt(activeNote.noteValue)
            reset(activeNote.noteValue)
        }
    }, [activeNote, flush, reset, setNoteTitle])

    return (
        <div
            className={styles.editorWrapper}
            onBlur={() => flush()}
        >
            <PromptEditor
                id="notes-widget-editor"
                value={prompt}
                onChange={setPrompt}
                height="auto"
                maxLength={400000}
                variant="seamless"
            />
        </div>
    )
}
