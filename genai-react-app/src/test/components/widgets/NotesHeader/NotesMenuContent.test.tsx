import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import NotesMenuContent from '../../../../components/widgets/NotesHeader/NotesMenuContent'
import { getNotes } from '../../../../services/saveNotesService'
import { loadNotesCache } from '../../../../components/widgets/SidebarWidgets/SavedNotesWidget/notesCache'

const mockOpenNote = jest.fn()
const mockShowToast = jest.fn()
jest.mock('../../../../context/NotesContext', () => ({
    useNotes: () => ({ openNote: mockOpenNote }),
}))
jest.mock('../../../../context/ToastContext', () => ({
    useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('../../../../context/AuthContext', () => ({
    useAuth: () => ({ customerId: 'c1', getAccessTokenSilently: jest.fn().mockResolvedValue('token') }),
}))
jest.mock('../../../../services/saveNotesService')
jest.mock('../../../../components/widgets/SidebarWidgets/SavedNotesWidget/notesCache')
jest.mock('../../../../components/widgets/SidebarWidgets/SavedNotesWidget/SavedNotesWidget', () => ({
    __esModule: true,
    default: () => <div data-testid="notes" />,
}))
jest.mock('../../../../components/widgets/MobileMenuBody/MenuSearchResults', () => ({
    __esModule: true,
    default: ({ onSelect }: any) => (
        <button data-testid="result" onClick={() => onSelect({ key: 'n1' })}>result</button>
    ),
}))

const note = { noteKey: 'n1', noteValue: 'text' }

describe('NotesMenuContent', () => {
    const search = (onClose = jest.fn()) => {
        render(<NotesMenuContent onClose={onClose} />)
        expect(screen.getByTestId('notes')).toBeInTheDocument()
        fireEvent.change(screen.getByTestId('mobile-menu-search'), { target: { value: 'tax' } })
        fireEvent.click(screen.getByTestId('result'))
        return onClose
    }

    beforeEach(() => jest.clearAllMocks())

    test('opens a result from the cached notes', async () => {
        ;(loadNotesCache as jest.Mock).mockReturnValue([note])
        const onClose = search()
        await waitFor(() => expect(mockOpenNote).toHaveBeenCalledWith(note))
        expect(onClose).toHaveBeenCalled()
        expect(getNotes).not.toHaveBeenCalled()
    })

    test('fetches the notes when the result is not cached', async () => {
        ;(loadNotesCache as jest.Mock).mockReturnValue(null)
        ;(getNotes as jest.Mock).mockResolvedValue([note])
        search()
        await waitFor(() => expect(mockOpenNote).toHaveBeenCalledWith(note))
    })

    test('shows a toast and stays open when the note is gone', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        ;(loadNotesCache as jest.Mock).mockReturnValue([])
        ;(getNotes as jest.Mock).mockResolvedValue([])
        const onClose = search()
        await waitFor(() => expect(mockShowToast).toHaveBeenCalled())
        expect(mockOpenNote).not.toHaveBeenCalled()
        expect(onClose).not.toHaveBeenCalled()
    })
})
