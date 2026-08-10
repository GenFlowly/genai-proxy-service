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
})

export function NotesProvider({ children }: { children: ReactNode }) {
    const [activeNote, setActiveNote] = useState<SavedNote | null>(null)
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

    const openNote = useCallback((note: SavedNote) => setActiveNote(note), [])
    const clearActiveNote = useCallback(() => setActiveNote(null), [])
    const setSaveState = useCallback((status: SaveStatus, savedAt: Date | null) => {
        setSaveStatus(status)
        setLastSavedAt(savedAt)
    }, [])

    return (
        <NotesContext.Provider
            value={{ activeNote, openNote, clearActiveNote, saveStatus, lastSavedAt, setSaveState }}
        >
            {children}
        </NotesContext.Provider>
    )
}

export const useNotes = () => useContext(NotesContext)
