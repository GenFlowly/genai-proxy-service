import React from 'react'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import ConversationHistoryComponent from '../../../../components/widgets/ConversationHistoryWidget/ConversationHistoryComponent'
import { useAuth } from '../../../../context/AuthContext'
import { useConversation } from '../../../../context/ConversationContext'
import {
    getCustomerConversations,
    getPinnedConversations,
    archiveConversation,
    pinConversation,
    unpinConversation,
} from '../../../../services/conversationHistoryService'
import { clearHistoryCache } from '../../../../components/widgets/ConversationHistoryWidget/historyCache'

jest.mock('../../../../context/AuthContext')
jest.mock('../../../../context/ConversationContext')
jest.mock('../../../../context/ToastContext', () => ({
    useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('../../../../services/conversationHistoryService')
let mockParams = { conversationId: undefined as string | undefined }

jest.mock('react-router-dom', () => ({
    useNavigate: () => mockNavigate,
    useParams: () => mockParams,
}))
jest.mock('../../../../components/widgets/ConversationHistoryWidget/ConversationHistory.module.scss', () => ({}), { virtual: true })

const mockNavigate = jest.fn()
const mockShowToast = jest.fn()
const mockGetAccessTokenSilently = jest.fn().mockResolvedValue('mock-token')
const mockGetCustomerConversations = getCustomerConversations as jest.Mock
const mockGetPinnedConversations = getPinnedConversations as jest.Mock

const defaultConversations = [
    { conversationId: 'conv-1', title: 'First Chat', createdAt: null, updatedAt: null },
    { conversationId: 'conv-2', title: null, createdAt: null, updatedAt: null },
]

function setupMocks({
    isAuthenticated = true,
    conversationId = '',
    conversationTitle = null as string | null,
    activeId = undefined as string | undefined,
} = {}) {
    mockParams = { conversationId: activeId }
    mockGetAccessTokenSilently.mockResolvedValue('mock-token')
    ;(useAuth as jest.Mock).mockReturnValue({
        isAuthenticated,
        customerId: 'cust-1',
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
        clearHistoryCache() // The module-level SWR cache must not leak between tests
        setupMocks()
        mockGetCustomerConversations.mockResolvedValue({
            conversations: defaultConversations,
            lastEvaluatedKey: null,
        })
        mockGetPinnedConversations.mockResolvedValue({ conversations: [] })
    })

    test('renders Recents heading once conversations load', async () => {
        render(<ConversationHistoryComponent />)
        await waitFor(() => {
            expect(screen.getByText('Recents')).toBeInTheDocument()
        })
    })

    test('renders Pinned heading above Recents when there are pinned conversations', async () => {
        mockGetPinnedConversations.mockResolvedValue({
            conversations: [
                { conversationId: 'conv-pinned', title: 'Pinned Chat', createdAt: null, updatedAt: null },
            ],
        })

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByText('Pinned')).toBeInTheDocument()
        })
        const pinnedHeading = screen.getByText('Pinned')
        const recentHeading = screen.getByText('Recents')
        // Pinned section renders before Recent
        expect(
            pinnedHeading.compareDocumentPosition(recentHeading) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
        // Both headings share the same style
        expect(pinnedHeading.className).toBe(recentHeading.className)
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

    test('archives a conversation when archive button is clicked', async () => {
        ;(archiveConversation as jest.Mock).mockResolvedValue(undefined)

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
        })

        const archiveBtn = screen.getByTestId('conv-archive-btn-conv-1')
        fireEvent.click(archiveBtn)

        await waitFor(() => {
            expect(archiveConversation).toHaveBeenCalledWith('mock-token', 'conv-1')
        })

        // Wait for it to be removed from the list
        await waitFor(() => {
            expect(screen.queryByTestId('conv-history-item-conv-1')).not.toBeInTheDocument()
        })
    })

    test('navigates to /chat if the archived conversation is the active one', async () => {
        setupMocks({ conversationId: 'conv-1', conversationTitle: null, activeId: 'conv-1' })
        ;(archiveConversation as jest.Mock).mockResolvedValue(undefined)

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
        })

        const archiveBtn = screen.getByTestId('conv-archive-btn-conv-1')
        fireEvent.click(archiveBtn)

        await waitFor(() => {
            expect(archiveConversation).toHaveBeenCalledWith('mock-token', 'conv-1')
        })

        await waitFor(() => {
            expect(mockNavigate).toHaveBeenCalledWith('/chat')
        })
    })

    test('does not navigate to / if the archived conversation is not the active one', async () => {
        setupMocks({ conversationId: 'conv-2', conversationTitle: null, activeId: 'conv-2' })
        ;(archiveConversation as jest.Mock).mockResolvedValue(undefined)

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
        })

        const archiveBtn = screen.getByTestId('conv-archive-btn-conv-1')
        fireEvent.click(archiveBtn)

        await waitFor(() => {
            expect(archiveConversation).toHaveBeenCalledWith('mock-token', 'conv-1')
        })

        await waitFor(() => {
            expect(screen.queryByTestId('conv-history-item-conv-1')).not.toBeInTheDocument()
        })

        expect(mockNavigate).not.toHaveBeenCalledWith('/')
    })

    describe('pinned conversations', () => {
        test('renders Pinned section first and excludes pinned items from date groups', async () => {
            mockGetPinnedConversations.mockResolvedValue({
                conversations: [
                    { conversationId: 'conv-1', title: 'First Chat', createdAt: null, updatedAt: null, pinnedAt: '2026-08-30T00:00:00Z' },
                ],
            })

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByText('Pinned')).toBeInTheDocument()
            })

            // conv-1 appears exactly once (in the Pinned group), conv-2 stays in date groups
            expect(screen.getAllByTestId('conv-history-item-conv-1')).toHaveLength(1)
            expect(screen.getByTestId('conv-unpin-btn-conv-1')).toBeInTheDocument()
            expect(screen.getByTestId('conv-pin-btn-conv-2')).toBeInTheDocument()
            // Pinned group renders before the date groups
            const pinnedHeader = screen.getByText('Pinned')
            const item = screen.getByTestId('conv-history-item-conv-2')
            expect(pinnedHeader.compareDocumentPosition(item)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
        })

        test('pinning moves the item to Pinned and shows a toast', async () => {
            ;(pinConversation as jest.Mock).mockResolvedValue(undefined)

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-pin-btn-conv-1')).toBeInTheDocument()
            })

            fireEvent.click(screen.getByTestId('conv-pin-btn-conv-1'))

            await waitFor(() => {
                expect(pinConversation).toHaveBeenCalledWith('mock-token', 'conv-1')
            })
            await waitFor(() => {
                expect(mockShowToast).toHaveBeenCalledWith('Conversation pinned')
            })

            expect(screen.getByText('Pinned')).toBeInTheDocument()
            // Now in the Pinned section: unpin button replaces the pin button
            expect(screen.getByTestId('conv-unpin-btn-conv-1')).toBeInTheDocument()
            expect(screen.queryByTestId('conv-pin-btn-conv-1')).not.toBeInTheDocument()
            expect(screen.getAllByTestId('conv-history-item-conv-1')).toHaveLength(1)
        })

        test('failed pin reverts the optimistic move and shows an error toast', async () => {
            ;(pinConversation as jest.Mock).mockRejectedValue(new Error('nope'))

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-pin-btn-conv-1')).toBeInTheDocument()
            })

            fireEvent.click(screen.getByTestId('conv-pin-btn-conv-1'))

            await waitFor(() => {
                expect(mockShowToast).toHaveBeenCalledWith('Failed to pin conversation')
            })

            expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
            expect(screen.getByTestId('conv-pin-btn-conv-1')).toBeInTheDocument()
        })

        test('unpinning returns the item to the date groups and shows a toast', async () => {
            mockGetPinnedConversations.mockResolvedValue({
                conversations: [
                    { conversationId: 'conv-9', title: 'Pinned Chat', createdAt: null, updatedAt: null, pinnedAt: '2026-08-30T00:00:00Z' },
                ],
            })
            ;(unpinConversation as jest.Mock).mockResolvedValue(undefined)

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-unpin-btn-conv-9')).toBeInTheDocument()
            })

            fireEvent.click(screen.getByTestId('conv-unpin-btn-conv-9'))

            await waitFor(() => {
                expect(unpinConversation).toHaveBeenCalledWith('mock-token', 'conv-9')
            })
            await waitFor(() => {
                expect(mockShowToast).toHaveBeenCalledWith('Conversation unpinned')
            })

            // Pinned section disappears; conv-9 (not in the loaded pages) was
            // inserted into the date-grouped list
            expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
            expect(screen.getByTestId('conv-history-item-conv-9')).toBeInTheDocument()
            expect(screen.getByTestId('conv-pin-btn-conv-9')).toBeInTheDocument()
        })

        test('archiving a pinned conversation removes it from the Pinned section', async () => {
            mockGetPinnedConversations.mockResolvedValue({
                conversations: [
                    { conversationId: 'conv-1', title: 'First Chat', createdAt: null, updatedAt: null, pinnedAt: '2026-08-30T00:00:00Z' },
                ],
            })
            ;(archiveConversation as jest.Mock).mockResolvedValue(undefined)

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByText('Pinned')).toBeInTheDocument()
            })

            fireEvent.click(screen.getByTestId('conv-archive-btn-conv-1'))

            await waitFor(() => {
                expect(archiveConversation).toHaveBeenCalledWith('mock-token', 'conv-1')
            })
            await waitFor(() => {
                expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
            })
            expect(screen.queryByTestId('conv-history-item-conv-1')).not.toBeInTheDocument()
        })

        test('a failed pinned fetch does not break the history list', async () => {
            mockGetPinnedConversations.mockRejectedValue(new Error('boom'))

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
            })
            expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
        })
    })

    describe('projects section', () => {
        const projectConversations = [
            { conversationId: 'conv-p1', title: 'Project chat 1', createdAt: null, updatedAt: null, projectId: 'proj-1', projectName: 'Project One' },
            { conversationId: 'conv-p2', title: 'Project chat 2', createdAt: null, updatedAt: null, projectId: 'proj-1', projectName: 'Project One' },
        ]

        test('groups project conversations under a collapsible project entry', async () => {
            mockGetCustomerConversations.mockResolvedValue({
                conversations: [...projectConversations, ...defaultConversations],
                lastEvaluatedKey: null,
            })
            mockGetPinnedConversations.mockResolvedValue({
                conversations: [
                    { conversationId: 'conv-p3', title: 'Pinned project chat', createdAt: null, updatedAt: null, pinnedAt: '2026-08-30T00:00:00Z', projectId: 'proj-1', projectName: 'Project One' },
                ],
            })

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByText('Projects')).toBeInTheDocument()
            })

            // The project renders as a collapsed row named after the project;
            // its conversations stay hidden until it is expanded
            const projectRow = screen.getByTestId('conv-history-project-proj-1')
            expect(projectRow).toHaveAttribute('aria-expanded', 'false')
            expect(screen.getByText('Project One')).toBeInTheDocument()
            expect(screen.queryByTestId('conv-history-item-conv-p1')).not.toBeInTheDocument()
            // Non-project conversations stay in the global Recents section
            expect(screen.getByText('Recents')).toBeInTheDocument()
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
            // The only pinned conversation belongs to the project, so there is
            // no global Pinned section
            expect(screen.queryByText('Pinned')).not.toBeInTheDocument()

            fireEvent.click(projectRow)

            expect(projectRow).toHaveAttribute('aria-expanded', 'true')
            // Project subsections: Pinned then Recent, holding its conversations
            expect(screen.getByText('Pinned')).toBeInTheDocument()
            expect(screen.getByText('Recent')).toBeInTheDocument()
            expect(screen.getByTestId('conv-history-item-conv-p3')).toBeInTheDocument()
            expect(screen.getByTestId('conv-history-item-conv-p1')).toBeInTheDocument()
            expect(screen.getByTestId('conv-history-item-conv-p2')).toBeInTheDocument()
        })

        test('project holding the active conversation starts expanded', async () => {
            setupMocks({ activeId: 'conv-p1' })
            mockGetCustomerConversations.mockResolvedValue({
                conversations: [...projectConversations, ...defaultConversations],
                lastEvaluatedKey: null,
            })

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-history-project-proj-1')).toBeInTheDocument()
            })
            expect(screen.getByTestId('conv-history-project-proj-1')).toHaveAttribute('aria-expanded', 'true')
            expect(screen.getByTestId('conv-history-item-conv-p1')).toBeInTheDocument()
        })

        test('Projects section renders above the global Pinned and Recents sections', async () => {
            mockGetCustomerConversations.mockResolvedValue({
                conversations: [...projectConversations, ...defaultConversations],
                lastEvaluatedKey: null,
            })
            mockGetPinnedConversations.mockResolvedValue({
                conversations: [
                    { conversationId: 'conv-g1', title: 'Globally pinned', createdAt: null, updatedAt: null, pinnedAt: '2026-08-30T00:00:00Z' },
                ],
            })

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByText('Projects')).toBeInTheDocument()
            })

            const projectsHeading = screen.getByText('Projects')
            const pinnedHeading = screen.getByText('Pinned')
            const recentsHeading = screen.getByText('Recents')
            expect(
                projectsHeading.compareDocumentPosition(pinnedHeading) & Node.DOCUMENT_POSITION_FOLLOWING
            ).toBeTruthy()
            expect(
                pinnedHeading.compareDocumentPosition(recentsHeading) & Node.DOCUMENT_POSITION_FOLLOWING
            ).toBeTruthy()
        })

        test('history without project conversations shows no Projects section', async () => {
            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByText('Recents')).toBeInTheDocument()
            })
            expect(screen.queryByText('Projects')).not.toBeInTheDocument()
        })
    })
})
