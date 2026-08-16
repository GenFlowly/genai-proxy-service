import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { SavedNote } from '../services/saveNotesService'
import { SaveStatus } from '../hooks/useAutosave'

interface NotesContextType {
    activeNote: SavedNote | null
    openNote: (note: SavedNote) => void
    clearActiveNote: () => void
    // "New Note" action: clears the active note AND signals the editor to
    // start a fresh session even when no note was active. Unlike
    // clearActiveNote (archive), pending edits are saved, not dropped.
    startNewNote: () => void
    // Bumped by startNewNote so the editor can react to repeated requests
    newNoteRequestId: number
    saveStatus: SaveStatus
    lastSavedAt: Date | null
    setSaveState: (status: SaveStatus, lastSavedAt: Date | null) => void
    // Title of the note currently being edited (server-generated or loaded);
    // shown in the notes header
    noteTitle: string | null
    setNoteTitle: (title: string | null) => void
    // Most recently saved note, published by the editor so the saved-notes
    // sidebar can update its list without refetching
    updatedNote: SavedNote | null
    publishNoteUpdate: (note: SavedNote) => void
}

// Safe defaults so components using the hook still work outside the provider
// (e.g. NotesWidget rendered on a page without a notes sidebar)
const NotesContext = createContext<NotesContextType>({
    activeNote: null,
    openNote: () => {},
    clearActiveNote: () => {},
    startNewNote: () => {},
    newNoteRequestId: 0,
    saveStatus: 'idle',
    lastSavedAt: null,
    setSaveState: () => {},
    noteTitle: null,
    setNoteTitle: () => {},
    updatedNote: null,
    publishNoteUpdate: () => {},
})

export function NotesProvider({ children }: { children: ReactNode }) {
    const [activeNote, setActiveNote] = useState<SavedNote | null>(null)
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
    const [noteTitle, setNoteTitle] = useState<string | null>(null)
    const [updatedNote, setUpdatedNote] = useState<SavedNote | null>(null)
    const [newNoteRequestId, setNewNoteRequestId] = useState(0)

    const openNote = useCallback((note: SavedNote) => setActiveNote(note), [])
    const clearActiveNote = useCallback(() => setActiveNote(null), [])
    const startNewNote = useCallback(() => {
        setActiveNote(null)
        setNewNoteRequestId(id => id + 1)
    }, [])
    const setSaveState = useCallback((status: SaveStatus, savedAt: Date | null) => {
        setSaveStatus(status)
        setLastSavedAt(savedAt)
    }, [])
    const publishNoteUpdate = useCallback((note: SavedNote) => setUpdatedNote(note), [])

    return (
        <NotesContext.Provider
            value={{
                activeNote,
                openNote,
                clearActiveNote,
                startNewNote,
                newNoteRequestId,
                saveStatus,
                lastSavedAt,
                setSaveState,
                noteTitle,
                setNoteTitle,
                updatedNote,
                publishNoteUpdate,
            }}
        >
            {children}
        </NotesContext.Provider>
    )
}

export const useNotes = () => useContext(NotesContext)
