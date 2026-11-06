import React, { useState, useEffect, useCallback, useRef } from 'react'
import { TextEditor } from '@genflowly/component-library'
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
    const { activeNote, newNoteRequestId, setSaveState, setNoteTitle, publishNoteUpdate } = useNotes()
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

    // Load the note selected in the Saved Notes sidebar into the editor; when
    // the active note is cleared (deleted) or a new note is requested, start
    // a fresh empty note
    const handledNewNoteRequestRef = useRef(newNoteRequestId)
    useEffect(() => {
        const isNewNoteRequest = newNoteRequestId !== handledNewNoteRequestRef.current
        handledNewNoteRequestRef.current = newNoteRequestId

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
        } else {
            // "New Note" saves pending edits under the note being left; a
            // plain clear (delete) drops them instead — saving them would
            // recreate the deleted note
            if (isNewNoteRequest) flush()
            noteKeyRef.current = newNoteKey()
            createdAtRef.current = new Date().toISOString()
            titleRef.current = undefined
            setNoteTitle(null)
            setPrompt('')
            reset('')
        }
    }, [activeNote, newNoteRequestId, flush, reset, setNoteTitle])

    return (
        <div
            className={styles.editorWrapper}
            onBlur={() => flush()}
        >
            <TextEditor
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
