import React from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import NotesHeader from '../../../../components/widgets/NotesHeader/NotesHeader'
import { NotesProvider, useNotes } from '../../../../context/NotesContext'
import { SaveStatus } from '../../../../hooks/useAutosave'

function SetSaveState({ status, savedAt }: { status: SaveStatus; savedAt: Date | null }) {
    const { setSaveState } = useNotes()
    React.useEffect(() => {
        setSaveState(status, savedAt)
    }, [status, savedAt, setSaveState])
    return null
}

describe('NotesHeader', () => {
    test('renders the Memory title without any context providers', () => {
        render(<NotesHeader />)

        expect(screen.getByTestId('notes-header')).toBeInTheDocument()
        expect(screen.getByText('Memory')).toBeInTheDocument()
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
