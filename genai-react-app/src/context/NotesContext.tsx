import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { SavedNote } from '../services/saveNotesService'
import { SaveStatus } from '../hooks/useAutosave'

interface NotesContextType {
    activeNote: SavedNote | null
    openNote: (note: SavedNote) => void
    clearActiveNote: () => void
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

    const openNote = useCallback((note: SavedNote) => setActiveNote(note), [])
    const clearActiveNote = useCallback(() => setActiveNote(null), [])
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
