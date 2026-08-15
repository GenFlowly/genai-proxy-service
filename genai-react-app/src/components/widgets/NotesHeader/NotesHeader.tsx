import React from 'react'
import PageHeader, { pageHeaderStyles } from '../../common/PageHeader/PageHeader'
import { useNotes } from '../../../context/NotesContext'
import { SaveStatus } from '../../../hooks/useAutosave'
import { parseServerDate } from '../../../utils/timeUtils'

function formatSavedAt(savedAt: Date): string {
    return savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatUpdatedAt(updatedAt: Date): string {
    const now = new Date()
    const sameDay = updatedAt.toDateString() === now.toDateString()
    if (sameDay) return `at ${formatSavedAt(updatedAt)}`

    const date = updatedAt.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        ...(updatedAt.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    })
    return `${date} at ${formatSavedAt(updatedAt)}`
}

function statusLabel(status: SaveStatus, lastSavedAt: Date | null, noteUpdatedAt: string | null): string | null {
    switch (status) {
        case 'saving':
            return 'Saving…'
        case 'error':
            return "Couldn't save. Retrying…"
        default:
            if (lastSavedAt) return `Saved at ${formatSavedAt(lastSavedAt)}`
            // No save this session yet: fall back to the note's stored
            // timestamp (server value — parse as UTC)
            if (noteUpdatedAt) {
                const updatedAt = parseServerDate(noteUpdatedAt)
                if (updatedAt) return `Updated ${formatUpdatedAt(updatedAt)}`
            }
            return null
    }
}

export default function NotesHeader(): React.ReactElement {
    const { saveStatus, lastSavedAt, noteTitle, activeNote } = useNotes()
    const label = statusLabel(saveStatus, lastSavedAt, activeNote?.updatedAt ?? null)

    // No title yet: a fresh editor session is a "New Note"; an opened note
    // whose stored title is missing is an "Untitled Note"
    const title = noteTitle ?? (activeNote ? 'Untitled Note' : 'New Note')

    return (
        <PageHeader
            title={title}
            data-testid="notes-header"
            actions={
                label && (
                    <span
                        className={`${pageHeaderStyles.saveStatus} ${saveStatus === 'error' ? pageHeaderStyles.saveStatusError : ''}`}
                        data-testid="notes-save-status"
                    >
                        {label}
                    </span>
                )
            }
        />
    )
}
