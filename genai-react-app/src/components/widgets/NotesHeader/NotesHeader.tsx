import React from 'react'
import PageHeader, { pageHeaderStyles } from '../../common/PageHeader/PageHeader'
import { useNotes } from '../../../context/NotesContext'
import { SaveStatus } from '../../../hooks/useAutosave'

function formatSavedAt(savedAt: Date): string {
    return savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function statusLabel(status: SaveStatus, lastSavedAt: Date | null): string | null {
    switch (status) {
        case 'saving':
            return 'Saving…'
        case 'error':
            return "Couldn't save. Retrying…"
        default:
            return lastSavedAt ? `Saved at ${formatSavedAt(lastSavedAt)}` : null
    }
}

export default function NotesHeader(): React.ReactElement {
    const { saveStatus, lastSavedAt, noteTitle } = useNotes()
    const label = statusLabel(saveStatus, lastSavedAt)

    return (
        <PageHeader
            title={noteTitle ?? 'Memory'}
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
