import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { NotesProvider } from '../../context/NotesContext'
import SavedNotesWidget from '../../components/widgets/SidebarWidgets/SavedNotesWidget/SavedNotesWidget'
import PlainNotes from '../../components/widgets/CenterWidgets/NotesWidget/PlainNotes'
import * as saveNotesService from '../../services/saveNotesService'
import { sidebarListPanelStyles } from '@genflowly/component-library'

jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('mock-token') }),
}))
jest.mock('../../services/saveNotesService')

// Mock PromptEditor to make it testable
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    PromptEditor: function MockPromptEditor(props: any) {
        return (
            <textarea
                data-testid={props.id}
                value={props.value}
                onChange={(e) => props.onChange(e.target.value)}
            />
        )
    },
}))

const mockGetNotes = saveNotesService.getNotes as jest.Mock

describe('useNotes outside provider', () => {
    test('falls back to safe no-op defaults', () => {
        const { useNotes } = jest.requireActual('../../context/NotesContext')

        const Probe = () => {
            const { activeNote, openNote, clearActiveNote } = useNotes()
            // Default no-ops: calling them must not throw or change anything
            openNote({ noteKey: 'k', noteValue: 'v', title: 't', createdAt: '', updatedAt: '' })
            clearActiveNote()
            return <div data-testid="probe">{activeNote === null ? 'null' : 'set'}</div>
        }

        render(<Probe />)
        expect(screen.getByTestId('probe')).toHaveTextContent('null')
    })
})

describe('Notes flow (sidebar -> editor)', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetNotes.mockResolvedValue([
            { noteKey: 'k1', noteValue: 'Remember the milk', title: 'Groceries', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z' },
        ])
    })

    test('clicking a saved note loads its content into the prompt editor', async () => {
        render(
            <NotesProvider>
                <SavedNotesWidget />
                <PlainNotes />
            </NotesProvider>
        )

        const editor = screen.getByTestId('notes-widget-editor') as HTMLTextAreaElement
        expect(editor.value).toBe('')

        const noteButton = await screen.findByTestId('saved-note-k1')
        fireEvent.click(noteButton)

        await waitFor(() => {
            expect(editor).toHaveValue('Remember the milk')
        })
    })

    test('clicked note is highlighted as active', async () => {
        render(
            <NotesProvider>
                <SavedNotesWidget />
                <PlainNotes />
            </NotesProvider>
        )

        const noteButton = await screen.findByTestId('saved-note-k1')
        expect(sidebarListPanelStyles.active).toBeTruthy()
        expect(noteButton.className).not.toContain(sidebarListPanelStyles.active)

        fireEvent.click(noteButton)

        await waitFor(() => {
            expect(noteButton.className).toContain(sidebarListPanelStyles.active)
        })
    })
})
