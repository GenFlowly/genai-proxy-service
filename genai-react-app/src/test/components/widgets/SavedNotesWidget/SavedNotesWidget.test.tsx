import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import SavedNotesWidget from '../../../../components/widgets/SidebarWidgets/SavedNotesWidget/SavedNotesWidget'
import { useAuth } from '../../../../context/AuthContext'
import * as saveNotesService from '../../../../services/saveNotesService'

jest.mock('../../../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}))
jest.mock('../../../../services/saveNotesService')

const mockUseAuth = useAuth as jest.Mock
const mockGetNotes = saveNotesService.getNotes as jest.Mock

describe('SavedNotesWidget', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockUseAuth.mockReturnValue({
            getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token'),
        })
    })

    test('shows loading state, then renders fetched notes', async () => {
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: 'note body', title: 'First note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
            { noteKey: 'k2', noteValue: 'second body line', title: 'Untitled', createdAt: '2026-08-02T10:00:00Z', updatedAt: '2026-08-02T10:00:00Z' },
        ])

        render(<SavedNotesWidget />)

        expect(screen.getByTestId('saved-notes-loading')).toBeInTheDocument()

        await waitFor(() => {
            expect(screen.getByTestId('saved-notes-list')).toBeInTheDocument()
        })

        expect(screen.getByText('First note')).toBeInTheDocument()
        // Untitled notes fall back to the first line of the note body
        expect(screen.getByText('second body line')).toBeInTheDocument()
    })

    test('shows empty state when customer has no notes', async () => {
        mockGetNotes.mockResolvedValue([])

        render(<SavedNotesWidget />)

        await waitFor(() => {
            expect(screen.getByTestId('saved-notes-empty')).toBeInTheDocument()
        })
        expect(screen.getByText('No saved notes yet')).toBeInTheDocument()
    })

    test('shows error state when fetch fails', async () => {
        mockGetNotes.mockRejectedValue(new Error('network down'))

        render(<SavedNotesWidget />)

        await waitFor(() => {
            expect(screen.getByTestId('saved-notes-error')).toBeInTheDocument()
        })
    })

    test('hides the date for notes with an invalid createdAt', async () => {
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: 'body', title: 'Bad date note', createdAt: 'not-a-date', updatedAt: '' },
        ])

        render(<SavedNotesWidget />)

        const note = await screen.findByTestId('saved-note-k1')
        expect(note).toHaveTextContent('Bad date note')
        // Only the title span is rendered — no date span
        expect(note.querySelectorAll('span')).toHaveLength(1)
    })

    test('falls back to Untitled when note has no title and no content', async () => {
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: '   \n  ', title: 'Untitled', createdAt: '2026-08-01T10:00:00Z', updatedAt: '' },
        ])

        render(<SavedNotesWidget />)

        expect(await screen.findByText('Untitled')).toBeInTheDocument()
    })

    test('honors a custom data-testid', async () => {
        mockGetNotes.mockResolvedValue([])

        render(<SavedNotesWidget data-testid="custom-notes-widget" />)

        expect(screen.getByTestId('custom-notes-widget')).toBeInTheDocument()
        await waitFor(() => {
            expect(screen.getByTestId('saved-notes-empty')).toBeInTheDocument()
        })
    })
})
