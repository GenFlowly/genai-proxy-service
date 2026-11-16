import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { MemoryRouter } from 'react-router-dom'
import ChatSidebar from '../../../../components/sections/ChatSidebar/ChatSidebar'
import { LayoutProvider, CHAT_SIDEBAR_STORAGE_KEY } from '../../../../context/LayoutContext'

const mockResetConversation = jest.fn()
jest.mock('../../../../context/ConversationContext', () => ({
    useConversation: () => ({ resetConversation: mockResetConversation }),
}))

const mockNavigate = jest.fn()
jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}))

jest.mock('../../../../components/widgets/ConversationHistoryWidget/ConversationHistoryComponent', () => ({
    __esModule: true,
    default: () => <div data-testid="history-cards" />,
}))

jest.mock('../../../../components/widgets/MobileMenuBody/MenuSearchResults', () => ({
    __esModule: true,
    default: ({ query, onSelect }: { query: string; onSelect: (r: { key: string }) => void }) => (
        <div data-testid="search-results">
            results for {query}
            <button data-testid="pick-result" onClick={() => onSelect({ key: 'conv-9' })}>pick</button>
        </div>
    ),
}))

const renderSidebar = () => render(
    <MemoryRouter>
        <LayoutProvider>
            <ChatSidebar />
        </LayoutProvider>
    </MemoryRouter>
)

describe('ChatSidebar', () => {
    beforeEach(() => {
        localStorage.clear()
        jest.clearAllMocks()
    })

    test('expanded: New Chat, the search field under it, the Projects and Chats cards, and the collapse strip', () => {
        renderSidebar()
        expect(screen.getByRole('complementary', { name: 'Chats and projects' })).toBeInTheDocument()
        const newChat = screen.getByTestId('new-chat-button')
        const search = screen.getByTestId('chat-sidebar-search')
        const cards = screen.getByTestId('history-cards')
        expect(newChat.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(search.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

        fireEvent.click(screen.getByTestId('new-chat-button'))
        expect(mockResetConversation).toHaveBeenCalledTimes(1)

        fireEvent.click(screen.getByRole('button', { name: 'Collapse Sidebar' }))
        expect(screen.getByTestId('chat-sidebar-rail')).toBeInTheDocument()
        expect(localStorage.getItem(CHAT_SIDEBAR_STORAGE_KEY)).toBe('collapsed')
    })

    test('rail: New Chat, the tabs and the chevron each work', () => {
        localStorage.setItem(CHAT_SIDEBAR_STORAGE_KEY, 'collapsed')
        renderSidebar()
        const rail = screen.getByTestId('chat-sidebar-rail')
        expect(rail).toHaveTextContent('Chats')
        expect(rail).toHaveTextContent('Projects')

        fireEvent.click(screen.getByRole('button', { name: 'New Chat' }))
        expect(mockResetConversation).toHaveBeenCalledTimes(1)

        fireEvent.click(screen.getByTestId('rail-projects'))
        expect(screen.getByTestId('history-cards')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Collapse Sidebar' }))
        fireEvent.click(screen.getByTestId('rail-chats'))
        expect(screen.getByTestId('history-cards')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Collapse Sidebar' }))
        fireEvent.click(screen.getByRole('button', { name: 'Expand Sidebar' }))
        expect(screen.getByTestId('history-cards')).toBeInTheDocument()
    })

    test('search from the rail expands the sidebar with the search field focused', () => {
        localStorage.setItem(CHAT_SIDEBAR_STORAGE_KEY, 'collapsed')
        renderSidebar()

        fireEvent.click(screen.getByRole('button', { name: 'Search chats' }))

        const field = screen.getByTestId('chat-sidebar-search')
        expect(field).toHaveFocus()
        expect(screen.getByTestId('history-cards')).toBeInTheDocument()
    })

    test('typing shows results in place of the cards; picking one opens it and clears the search', () => {
        renderSidebar()
        fireEvent.change(screen.getByTestId('chat-sidebar-search'), { target: { value: 'heater' } })

        expect(screen.getByTestId('search-results')).toHaveTextContent('results for heater')
        expect(screen.getByTestId('chat-sidebar-cards')).not.toBeVisible()

        fireEvent.click(screen.getByTestId('pick-result'))
        expect(mockNavigate).toHaveBeenCalledWith('/chat/conv-9')
        expect(screen.getByTestId('chat-sidebar-search')).toHaveValue('')
        expect(screen.getByTestId('chat-sidebar-cards')).toBeVisible()
    })

    test('Escape clears the search; the field stays, and so does an empty one that loses focus', () => {
        renderSidebar()
        fireEvent.change(screen.getByTestId('chat-sidebar-search'), { target: { value: 'x' } })
        fireEvent.keyDown(screen.getByTestId('chat-sidebar-search'), { key: 'Escape' })
        expect(screen.getByTestId('chat-sidebar-search')).toHaveValue('')
        expect(screen.queryByTestId('search-results')).not.toBeInTheDocument()

        fireEvent.blur(screen.getByTestId('chat-sidebar-search'))
        expect(screen.getByTestId('chat-sidebar-search')).toBeInTheDocument()
    })

    test('expanding the sidebar any other way leaves the search field unfocused', () => {
        localStorage.setItem(CHAT_SIDEBAR_STORAGE_KEY, 'collapsed')
        renderSidebar()

        fireEvent.click(screen.getByTestId('rail-chats'))

        expect(screen.getByTestId('chat-sidebar-search')).not.toHaveFocus()
    })
})
