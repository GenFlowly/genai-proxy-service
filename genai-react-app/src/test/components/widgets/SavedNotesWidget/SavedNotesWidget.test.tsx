import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import SavedNotesWidget from '../../../../components/widgets/SidebarWidgets/SavedNotesWidget/SavedNotesWidget'
import { useAuth } from '../../../../context/AuthContext'
import { NotesProvider, useNotes } from '../../../../context/NotesContext'
import * as saveNotesService from '../../../../services/saveNotesService'
import { loadNotesCache, saveNotesCache, clearNotesCache } from '../../../../components/widgets/SidebarWidgets/SavedNotesWidget/notesCache'

jest.mock('../../../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}))
jest.mock('../../../../services/saveNotesService')

const mockUseAuth = useAuth as jest.Mock
const mockGetNotes = saveNotesService.getNotes as jest.Mock
const mockDeleteNote = saveNotesService.deleteNote as jest.Mock

describe('SavedNotesWidget', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        clearNotesCache() // The module-level SWR cache must not leak between tests
        mockUseAuth.mockReturnValue({
            customerId: 'cust-1',
            getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token'),
        })
    })

    test('in the mobile menu the notes sit under one collapsible header', async () => {
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: 'note body', title: 'First note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
        ])

        render(<SavedNotesWidget menu />)

        const heading = await screen.findByTestId('saved-notes-heading')
        expect(screen.getByText('First note')).toBeInTheDocument()

        fireEvent.click(heading)
        expect(screen.queryByText('First note')).not.toBeInTheDocument()
        fireEvent.click(heading)
        expect(screen.getByText('First note')).toBeInTheDocument()
    })

    test('in the mobile menu an empty list still shows the empty state', async () => {
        mockGetNotes.mockResolvedValue([])
        render(<SavedNotesWidget menu />)
        expect(await screen.findByTestId('saved-notes-empty')).toBeInTheDocument()
        expect(screen.queryByTestId('saved-notes-heading')).not.toBeInTheDocument()
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

    test('merges published note updates into the list', async () => {
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: 'note body', title: 'First note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
        ])

        function PublishUpdate({ note }: { note: saveNotesService.SavedNote | null }) {
            const { publishNoteUpdate } = useNotes()
            React.useEffect(() => {
                if (note) publishNoteUpdate(note)
            }, [note, publishNoteUpdate])
            return null
        }

        const renderWithNote = (note: saveNotesService.SavedNote | null) => (
            <NotesProvider>
                <SavedNotesWidget />
                <PublishUpdate note={note} />
            </NotesProvider>
        )

        const { rerender } = render(renderWithNote(null))
        await waitFor(() => expect(screen.getByText('First note')).toBeInTheDocument())

        // Existing note updated in place (title generated by the server)
        rerender(renderWithNote({ noteKey: 'k1', noteValue: 'note body', title: 'Generated Title', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-03T10:00:00Z' }))
        expect(screen.getByText('Generated Title')).toBeInTheDocument()
        expect(screen.queryByText('First note')).not.toBeInTheDocument()

        // Brand-new note appears in the list
        rerender(renderWithNote({ noteKey: 'k2', noteValue: 'fresh note', title: 'Fresh Note', createdAt: '2026-08-04T10:00:00Z', updatedAt: '2026-08-04T10:00:00Z' }))
        expect(screen.getByText('Fresh Note')).toBeInTheDocument()
        expect(screen.getByText('Generated Title')).toBeInTheDocument()
    })

    test('deletes a note after the user confirms', async () => {
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: 'note body', title: 'First note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
            { noteKey: 'k2', noteValue: 'second body', title: 'Second note', createdAt: '2026-08-02T10:00:00Z', updatedAt: '2026-08-02T10:00:00Z' },
        ])
        mockDeleteNote.mockResolvedValue(undefined)

        render(<SavedNotesWidget />)

        await waitFor(() => {
            expect(screen.getByTestId('saved-note-k1')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByTestId('note-delete-btn-k1'))
        fireEvent.click(screen.getByTestId('delete-note-confirm'))

        await waitFor(() => {
            expect(mockDeleteNote).toHaveBeenCalledWith('mock-token', 'k1')
        })
        await waitFor(() => {
            expect(screen.queryByTestId('saved-note-k1')).not.toBeInTheDocument()
        })
        // The other note stays
        expect(screen.getByTestId('saved-note-k2')).toBeInTheDocument()
    })

    test('keeps the note in the list when the delete request fails', async () => {
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: 'note body', title: 'First note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
        ])
        mockDeleteNote.mockRejectedValue(new Error('server error'))

        render(<SavedNotesWidget />)

        await waitFor(() => {
            expect(screen.getByTestId('saved-note-k1')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByTestId('note-delete-btn-k1'))
        fireEvent.click(screen.getByTestId('delete-note-confirm'))

        await waitFor(() => {
            expect(mockDeleteNote).toHaveBeenCalled()
        })
        expect(screen.getByTestId('saved-note-k1')).toBeInTheDocument()
        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't delete the note")
    })

    test('nothing is deleted until the user confirms', async () => {
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: 'note body', title: 'First note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
        ])

        render(<SavedNotesWidget />)

        await waitFor(() => {
            expect(screen.getByTestId('saved-note-k1')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByTestId('note-delete-btn-k1'))
        expect(screen.getByTestId('delete-note')).toHaveTextContent("It's deleted for good")

        fireEvent.click(screen.getByTestId('delete-note-cancel'))

        expect(screen.queryByTestId('delete-note')).not.toBeInTheDocument()
        expect(mockDeleteNote).not.toHaveBeenCalled()
    })

    test('clears the active note when it is deleted', async () => {
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: 'note body', title: 'First note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
        ])
        mockDeleteNote.mockResolvedValue(undefined)

        function ActiveNoteProbe() {
            const { activeNote } = useNotes()
            return <div data-testid="active-note">{activeNote?.noteKey ?? 'none'}</div>
        }

        render(
            <NotesProvider>
                <SavedNotesWidget />
                <ActiveNoteProbe />
            </NotesProvider>
        )

        await waitFor(() => {
            expect(screen.getByTestId('saved-note-k1')).toBeInTheDocument()
        })

        // Open the note, then delete it
        fireEvent.click(screen.getByTestId('saved-note-k1'))
        expect(screen.getByTestId('active-note')).toHaveTextContent('k1')

        fireEvent.click(screen.getByTestId('note-delete-btn-k1'))
        fireEvent.click(screen.getByTestId('delete-note-confirm'))

        await waitFor(() => {
            expect(screen.getByTestId('active-note')).toHaveTextContent('none')
        })
    })

    test('paints cached notes instantly while refreshing in the background', async () => {
        saveNotesCache('cust-1', [
            { noteKey: 'k1', noteValue: 'cached body', title: 'Cached note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
        ])
        // Keep the refresh pending: the cached list must show without a skeleton
        mockGetNotes.mockReturnValue(new Promise(() => {}))

        render(<SavedNotesWidget />)

        expect(screen.getByText('Cached note')).toBeInTheDocument()
        expect(screen.queryByTestId('saved-notes-loading')).not.toBeInTheDocument()
    })

    test('replaces the cached list once the refresh lands and mirrors it to the cache', async () => {
        saveNotesCache('cust-1', [
            { noteKey: 'k1', noteValue: 'cached body', title: 'Stale note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
        ])
        const fresh = [
            { noteKey: 'k2', noteValue: 'fresh body', title: 'Fresh note', createdAt: '2026-08-02T10:00:00Z', updatedAt: '2026-08-02T10:00:00Z' },
        ]
        mockGetNotes.mockResolvedValue(fresh)

        render(<SavedNotesWidget />)

        await waitFor(() => {
            expect(screen.getByText('Fresh note')).toBeInTheDocument()
        })
        expect(screen.queryByText('Stale note')).not.toBeInTheDocument()
        expect(loadNotesCache('cust-1')).toEqual(fresh)
    })

    test('keeps showing the stale list when the background refresh fails', async () => {
        saveNotesCache('cust-1', [
            { noteKey: 'k1', noteValue: 'cached body', title: 'Cached note', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
        ])
        mockGetNotes.mockRejectedValue(new Error('network down'))

        render(<SavedNotesWidget />)

        await waitFor(() => {
            expect(mockGetNotes).toHaveBeenCalled()
        })
        expect(screen.getByText('Cached note')).toBeInTheDocument()
        expect(screen.queryByTestId('saved-notes-error')).not.toBeInTheDocument()
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
