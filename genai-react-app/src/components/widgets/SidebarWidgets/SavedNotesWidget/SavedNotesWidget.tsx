import React, { useState, useEffect } from 'react'
import { useAuth } from '../../../../context/AuthContext'
import { useNotes } from '../../../../context/NotesContext'
import { getNotes, SavedNote } from '../../../../services/saveNotesService'
import styles from './SavedNotesWidget.module.scss'

const formatDate = (isoDate: string): string => {
    const date = new Date(isoDate)
    if (isNaN(date.getTime())) return ''
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const noteLabel = (note: SavedNote): string => {
    if (note.title && note.title !== 'Untitled') return note.title
    const firstLine = note.noteValue.split('\n').find(line => line.trim().length > 0)
    return firstLine?.trim() || 'Untitled'
}

export default function SavedNotesWidget({ 'data-testid': testId }: { 'data-testid'?: string } = {}) {
    const { getAccessTokenSilently } = useAuth()
    const { openNote, activeNote, updatedNote } = useNotes()
    const [notes, setNotes] = useState<SavedNote[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [hasError, setHasError] = useState(false)

    useEffect(() => {
        let cancelled = false

        const fetchNotes = async () => {
            try {
                const token = await getAccessTokenSilently()
                const fetchedNotes = await getNotes(token)
                if (!cancelled) setNotes(fetchedNotes)
            } catch (error) {
                console.error('Failed to fetch saved notes:', error)
                if (!cancelled) setHasError(true)
            } finally {
                if (!cancelled) setIsLoading(false)
            }
        }

        fetchNotes()
        return () => { cancelled = true }
    }, [getAccessTokenSilently])

    // Keep the list in sync with autosaves published by the editor: update
    // saved notes in place, and surface brand-new notes at the top
    useEffect(() => {
        if (!updatedNote) return
        setNotes(prev => {
            const index = prev.findIndex(n => n.noteKey === updatedNote.noteKey)
            if (index === -1) return [updatedNote, ...prev]
            const next = [...prev]
            next[index] = updatedNote
            return next
        })
    }, [updatedNote])

    return (
        <div className={styles.savedNotesWidget} data-testid={testId || 'saved-notes-widget'}>
            <h3 className={styles.title}>Saved Notes</h3>

            {isLoading && (
                <p className={styles.stateMessage} data-testid="saved-notes-loading">Loading notes...</p>
            )}

            {!isLoading && hasError && (
                <p className={styles.stateMessage} data-testid="saved-notes-error">Could not load notes</p>
            )}

            {!isLoading && !hasError && notes.length === 0 && (
                <p className={styles.stateMessage} data-testid="saved-notes-empty">No saved notes yet</p>
            )}

            {!isLoading && !hasError && notes.length > 0 && (
                <div className={styles.notesList} data-testid="saved-notes-list">
                    {notes.map(note => (
                        <button
                            key={note.noteKey}
                            className={`${styles.noteItem} ${activeNote?.noteKey === note.noteKey ? styles.active : ''}`}
                            onClick={() => openNote(note)}
                            data-testid={`saved-note-${note.noteKey}`}
                        >
                            <span className={styles.noteTitle} title={noteLabel(note)}>
                                {noteLabel(note)}
                            </span>
                            {formatDate(note.createdAt) && (
                                <span className={styles.noteDate}>{formatDate(note.createdAt)}</span>
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
