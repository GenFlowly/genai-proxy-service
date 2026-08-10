import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { SavedNote } from '../services/saveNotesService'

interface NotesContextType {
    activeNote: SavedNote | null
    openNote: (note: SavedNote) => void
    clearActiveNote: () => void
}

// Safe defaults so components using the hook still work outside the provider
// (e.g. NotesWidget rendered on a page without a notes sidebar)
const NotesContext = createContext<NotesContextType>({
    activeNote: null,
    openNote: () => {},
    clearActiveNote: () => {},
})

export function NotesProvider({ children }: { children: ReactNode }) {
    const [activeNote, setActiveNote] = useState<SavedNote | null>(null)

    const openNote = useCallback((note: SavedNote) => setActiveNote(note), [])
    const clearActiveNote = useCallback(() => setActiveNote(null), [])

    return (
        <NotesContext.Provider value={{ activeNote, openNote, clearActiveNote }}>
            {children}
        </NotesContext.Provider>
    )
}

export const useNotes = () => useContext(NotesContext)
