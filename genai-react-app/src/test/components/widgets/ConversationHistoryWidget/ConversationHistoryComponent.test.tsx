import React from 'react'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import ConversationHistoryComponent from '../../../../components/widgets/ConversationHistoryWidget/ConversationHistoryComponent'
import { useAuth } from '../../../../context/AuthContext'
import { useConversation } from '../../../../context/ConversationContext'
import { getCustomerConversations } from '../../../../services/conversationHistoryService'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../context/ConversationContext')
jest.mock('../../../../services/conversationHistoryService')
jest.mock('react-router-dom', () => ({
    useNavigate: () => mockNavigate,
    useParams: () => ({ conversationId: undefined }),
}))
jest.mock('../../../../components/widgets/ConversationHistoryWidget/ConversationHistory.module.scss', () => ({}), { virtual: true })

const mockNavigate = jest.fn()
const mockGetAccessTokenSilently = jest.fn().mockResolvedValue('mock-token')
const mockGetCustomerConversations = getCustomerConversations as jest.Mock

const defaultConversations = [
    { conversationId: 'conv-1', title: 'First Chat', createdAt: null, updatedAt: null },
    { conversationId: 'conv-2', title: null, createdAt: null, updatedAt: null },
]

function setupMocks({
    isAuthenticated = true,
    conversationId = '',
    conversationTitle = null as string | null,
} = {}) {
    ;(useAuth as jest.Mock).mockReturnValue({
        isAuthenticated,
        getAccessTokenSilently: mockGetAccessTokenSilently,
    })
    ;(useConversation as jest.Mock).mockReturnValue({
        conversationId,
        conversationTitle,
    })
}

describe('ConversationHistoryComponent', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        setupMocks()
        mockGetCustomerConversations.mockResolvedValue({
            conversations: defaultConversations,
            lastEvaluatedKey: null,
        })
    })

    test('renders history header', async () => {
        render(<ConversationHistoryComponent />)
        expect(screen.getByText('History')).toBeInTheDocument()
    })

    test('shows skeleton while loading', () => {
        // Keep the promise pending so isLoading stays true
        mockGetCustomerConversations.mockReturnValue(new Promise(() => {}))
        render(<ConversationHistoryComponent />)
        // skeleton items rendered (5 divs from Array.from({ length: 5 }))
        // We can just check the loading state doesn't show the list
        expect(screen.queryByRole('list')).not.toBeInTheDocument()
    })

    test('renders conversation list after fetch', async () => {
        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
        })

        expect(screen.getByTestId('conv-history-item-conv-2')).toBeInTheDocument()
        // First conv shows title, second shows conversationId as fallback
        expect(screen.getByText('First Chat')).toBeInTheDocument()
        expect(screen.getByText('conv-2')).toBeInTheDocument()
    })

    test('shows empty state when no conversations', async () => {
        mockGetCustomerConversations.mockResolvedValue({
            conversations: [],
            lastEvaluatedKey: null,
        })

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByText('No conversations yet')).toBeInTheDocument()
        })
    })

    test('shows error state when fetch fails', async () => {
        mockGetCustomerConversations.mockRejectedValue(new Error('Network error'))

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByText('Failed to load history')).toBeInTheDocument()
        })
    })

    test('does not fetch when not authenticated', async () => {
        setupMocks({ isAuthenticated: false })

        render(<ConversationHistoryComponent />)

        await act(async () => {})
        expect(mockGetCustomerConversations).not.toHaveBeenCalled()
    })

    test('navigates to conversation on item click', async () => {
        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByTestId('conv-history-item-conv-1'))
        expect(mockNavigate).toHaveBeenCalledWith('/chat/conv-1')
    })

    test('shows Load more button when hasMore is true', async () => {
        mockGetCustomerConversations.mockResolvedValue({
            conversations: defaultConversations,
            lastEvaluatedKey: 'some-key',
        })

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-load-more')).toBeInTheDocument()
        })

        expect(screen.getByTestId('conv-history-load-more')).toHaveTextContent('Load more')
    })

    test('loads next page when Load more is clicked', async () => {
        const page2 = [{ conversationId: 'conv-3', title: 'Third', createdAt: null, updatedAt: null }]
        mockGetCustomerConversations
            .mockResolvedValueOnce({ conversations: defaultConversations, lastEvaluatedKey: 'page2-key' })
            .mockResolvedValueOnce({ conversations: page2, lastEvaluatedKey: null })

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-load-more')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByTestId('conv-history-load-more'))

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-3')).toBeInTheDocument()
        })

        // Original items still present
        expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
    })

    test('patches title of existing item when conversationTitle changes', async () => {
        // Start with no title
        setupMocks({ conversationId: 'conv-2', conversationTitle: null })

        const { rerender } = render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-2')).toBeInTheDocument()
        })

        // conv-2 originally had no title — shows conversationId as fallback
        expect(screen.getByText('conv-2')).toBeInTheDocument()

        // Simulate title arriving
        ;(useConversation as jest.Mock).mockReturnValue({
            conversationId: 'conv-2',
            conversationTitle: 'Updated Title',
        })
        rerender(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByText('Updated Title')).toBeInTheDocument()
        })
    })

    test('prepends new conversation to list when not already present', async () => {
        // Start with no title (title arrives after fetch)
        setupMocks({ conversationId: 'conv-new', conversationTitle: null })

        const { rerender } = render(<ConversationHistoryComponent />)

        // Wait for initial fetch to populate items
        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
        })

        // Simulate title being generated for the new conversation
        ;(useConversation as jest.Mock).mockReturnValue({
            conversationId: 'conv-new',
            conversationTitle: 'Brand New',
        })
        rerender(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-new')).toBeInTheDocument()
        })
        expect(screen.getByText('Brand New')).toBeInTheDocument()
    })

    test('does not update items when conversationTitle is null', async () => {
        setupMocks({ conversationId: 'conv-1', conversationTitle: null })

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
        })

        // Title should remain as-is from the fetched data
        expect(screen.getByText('First Chat')).toBeInTheDocument()
    })

    test('does not update items when conversationId is empty', async () => {
        setupMocks({ conversationId: '', conversationTitle: 'Some Title' })

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
        })

        // No new item should have been prepended
        expect(screen.queryByText('Some Title')).not.toBeInTheDocument()
    })
})
