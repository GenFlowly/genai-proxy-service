import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import NotesHeader from '../../../../components/widgets/NotesHeader/NotesHeader'
import { NotesProvider, useNotes } from '../../../../context/NotesContext'
import { SaveStatus } from '../../../../hooks/useAutosave'
import { SavedNote } from '../../../../services/saveNotesService'

function SetSaveState({ status, savedAt }: { status: SaveStatus; savedAt: Date | null }) {
    const { setSaveState } = useNotes()
    React.useEffect(() => {
        setSaveState(status, savedAt)
    }, [status, savedAt, setSaveState])
    return null
}

function SetNoteTitle({ title }: { title: string | null }) {
    const { setNoteTitle } = useNotes()
    React.useEffect(() => {
        setNoteTitle(title)
    }, [title, setNoteTitle])
    return null
}

const untitledNote: SavedNote = {
    noteKey: 'note-1',
    noteValue: 'some content',
    title: '',
    createdAt: '2026-08-10T10:00:00Z',
    updatedAt: '2026-08-10T10:05:00Z',
}

function OpenNote({ note }: { note: SavedNote }) {
    const { openNote } = useNotes()
    React.useEffect(() => {
        openNote(note)
    }, [note, openNote])
    return null
}

describe('NotesHeader', () => {
    test('renders the New Note title without any context providers', () => {
        render(<NotesHeader />)

        expect(screen.getByTestId('notes-header')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'New Note' })).toBeInTheDocument()
        expect(screen.queryByTestId('notes-save-status')).not.toBeInTheDocument()
    })

    test('shows "Saving…" while a save is in flight', () => {
        render(
            <NotesProvider>
                <NotesHeader />
                <SetSaveState status="saving" savedAt={null} />
            </NotesProvider>
        )

        expect(screen.getByTestId('notes-save-status')).toHaveTextContent('Saving…')
    })

    test('shows the last saved time after a save', () => {
        const savedAt = new Date('2026-08-10T15:30:00')
        render(
            <NotesProvider>
                <NotesHeader />
                <SetSaveState status="saved" savedAt={savedAt} />
            </NotesProvider>
        )

        expect(screen.getByTestId('notes-save-status')).toHaveTextContent(/Saved at/)
    })

    test('shows the note title once one is set, falling back to New Note', () => {
        const { rerender } = render(
            <NotesProvider>
                <NotesHeader />
                <SetNoteTitle title={null} />
            </NotesProvider>
        )
        expect(screen.getByRole('heading', { name: 'New Note' })).toBeInTheDocument()

        rerender(
            <NotesProvider>
                <NotesHeader />
                <SetNoteTitle title="Grocery List Ideas" />
            </NotesProvider>
        )
        expect(screen.getByText('Grocery List Ideas')).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'New Note' })).not.toBeInTheDocument()
    })

    test('shows the stored updated-at timestamp for an opened note before any save', () => {
        render(
            <NotesProvider>
                <NotesHeader />
                <OpenNote note={{ ...untitledNote, updatedAt: '2026-08-08T10:05:00Z' }} />
            </NotesProvider>
        )

        expect(screen.getByTestId('notes-save-status')).toHaveTextContent(/Updated/)
    })

    test('prefers the in-session save time over the stored timestamp', () => {
        const savedAt = new Date('2026-08-10T15:30:00')
        render(
            <NotesProvider>
                <NotesHeader />
                <OpenNote note={untitledNote} />
                <SetSaveState status="saved" savedAt={savedAt} />
            </NotesProvider>
        )

        expect(screen.getByTestId('notes-save-status')).toHaveTextContent(/Saved at/)
    })

    test('shows Untitled Note for an opened note without a title', () => {
        render(
            <NotesProvider>
                <NotesHeader />
                <OpenNote note={untitledNote} />
                <SetNoteTitle title={null} />
            </NotesProvider>
        )

        expect(screen.getByText('Untitled Note')).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'New Note' })).not.toBeInTheDocument()
    })

    test('starts a fresh note when the New Note button is clicked', () => {
        render(
            <NotesProvider>
                <NotesHeader />
                <OpenNote note={untitledNote} />
            </NotesProvider>
        )

        // A note is open — the header shows its (untitled) state
        expect(screen.getByText('Untitled Note')).toBeInTheDocument()

        fireEvent.click(screen.getByTestId('new-note-button'))

        // Active note cleared — back to a fresh New Note session
        expect(screen.getByRole('heading', { name: 'New Note' })).toBeInTheDocument()
        expect(screen.queryByText('Untitled Note')).not.toBeInTheDocument()
    })

    test('shows an error message when saving fails', () => {
        render(
            <NotesProvider>
                <NotesHeader />
                <SetSaveState status="error" savedAt={null} />
            </NotesProvider>
        )

        expect(screen.getByTestId('notes-save-status')).toHaveTextContent("Couldn't save. Retrying…")
    })
})
