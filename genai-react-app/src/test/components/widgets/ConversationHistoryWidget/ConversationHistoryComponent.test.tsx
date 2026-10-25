import React from 'react'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
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
    getProjects,
    createProject,
    assignConversationToProject,
    unassignConversationFromProject,
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
const mockStartConversationInProject = jest.fn()
const mockGetAccessTokenSilently = jest.fn().mockResolvedValue('mock-token')
const mockGetCustomerConversations = getCustomerConversations as jest.Mock
const mockGetPinnedConversations = getPinnedConversations as jest.Mock
const mockGetProjects = getProjects as jest.Mock
const mockCreateProject = createProject as jest.Mock
const mockAssignToProject = assignConversationToProject as jest.Mock
const mockUnassignFromProject = unassignConversationFromProject as jest.Mock

const defaultConversations = [
    { conversationId: 'conv-1', title: 'First Chat', createdAt: null, updatedAt: null },
    { conversationId: 'conv-2', title: null, createdAt: null, updatedAt: null },
]

function setupMocks({
    isAuthenticated = true,
    conversationId = '',
    conversationTitle = null as string | null,
    activeId = undefined as string | undefined,
    pendingProjectId = null as string | null,
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
        pendingProjectId,
        startConversationInProject: mockStartConversationInProject,
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
        mockGetProjects.mockResolvedValue({ projects: [] })
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

    test('with no conversations the Projects panel still offers its create control', async () => {
        mockGetCustomerConversations.mockResolvedValue({
            conversations: [],
            lastEvaluatedKey: null,
        })

        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('conv-history-new-project')).toBeInTheDocument()
        })
        expect(screen.getByText('Projects')).toBeInTheDocument()
        // The History panel below shows its own empty state
        expect(within(screen.getByTestId('history-pane')).getByText('No conversations yet')).toBeInTheDocument()
    })

    test('Projects and History render as separate stacked panels', async () => {
        render(<ConversationHistoryComponent />)

        await waitFor(() => {
            expect(screen.getByTestId('projects-pane')).toBeInTheDocument()
        })
        const projectsPane = screen.getByTestId('projects-pane')
        const historyPane = screen.getByTestId('history-pane')

        // Projects panel holds the Projects content; History holds Pinned/Recents
        expect(within(projectsPane).getByText('Projects')).toBeInTheDocument()
        expect(within(projectsPane).getByTestId('conv-history-new-project')).toBeInTheDocument()
        expect(within(historyPane).getByText('Recents')).toBeInTheDocument()
        expect(within(historyPane).queryByText('Projects')).not.toBeInTheDocument()

        // Stacked: Projects pane precedes the History pane
        expect(
            projectsPane.compareDocumentPosition(historyPane) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()

        // A draggable divider sits between the panes so their heights trade
        // off against each other
        const divider = screen.getByTestId('history-split-handle')
        expect(divider).toHaveAttribute('role', 'separator')
        expect(divider).toHaveAttribute('aria-label', 'Resize the Projects and History panels')
        expect(
            projectsPane.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
        expect(
            divider.compareDocumentPosition(historyPane) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
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

            // Pinned lives outside the scrollable list (it must not scroll
            // away); only the Recents list scrolls
            const scrollList = screen.getByTestId('history-scroll-list')
            expect(within(scrollList).queryByTestId('conv-history-item-conv-1')).not.toBeInTheDocument()
            expect(within(scrollList).getByTestId('conv-history-item-conv-2')).toBeInTheDocument()
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

        test('Projects header shows the create control even when nothing is grouped', async () => {
            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByText('Recents')).toBeInTheDocument()
            })
            expect(screen.getByText('Projects')).toBeInTheDocument()
            // The create control is a header icon button with a tooltip
            const createBtn = screen.getByTestId('conv-history-new-project')
            expect(createBtn).toHaveAttribute('title', 'New project')
            expect(createBtn).toHaveAttribute('aria-label', 'New project')
        })

        test('lists a project from the API as a collapsed entry even when empty', async () => {
            mockGetProjects.mockResolvedValue({
                projects: [
                    { projectId: 'proj-9', name: 'Empty One', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
                ],
            })

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-history-project-proj-9')).toBeInTheDocument()
            })
            expect(screen.getByText('Empty One')).toBeInTheDocument()
            // Nothing to expand yet: the row renders without a chevron or
            // expand semantics until a conversation lands in the project
            const row = screen.getByTestId('conv-history-project-proj-9')
            expect(row).not.toHaveAttribute('aria-expanded')
            expect(row.querySelector('svg')).toBeNull()
        })

        test('creates a project from the sidebar', async () => {
            mockCreateProject.mockResolvedValue({
                projectId: 'PRJNEW', name: 'My Research', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z',
            })

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-history-new-project')).toBeInTheDocument()
            })
            fireEvent.click(screen.getByTestId('conv-history-new-project'))

            const nameInput = screen.getByPlaceholderText('Project name')
            fireEvent.change(nameInput, { target: { value: 'My Research' } })
            fireEvent.click(screen.getByTestId('new-project-create-btn'))

            await waitFor(() => {
                expect(createProject).toHaveBeenCalledWith('mock-token', 'My Research')
            })
            await waitFor(() => {
                expect(screen.getByTestId('conv-history-project-PRJNEW')).toBeInTheDocument()
            })
            expect(mockShowToast).toHaveBeenCalledWith('Project created')
        })

        test('moves a conversation into a project via the picker', async () => {
            mockGetProjects.mockResolvedValue({
                projects: [
                    { projectId: 'proj-1', name: 'Research', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
                ],
            })
            mockAssignToProject.mockResolvedValue(undefined)

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-move-btn-conv-1')).toBeInTheDocument()
            })
            fireEvent.click(screen.getByTestId('conv-move-btn-conv-1'))
            fireEvent.click(screen.getByTestId('move-to-project-proj-1'))

            await waitFor(() => {
                expect(assignConversationToProject).toHaveBeenCalledWith('mock-token', 'conv-1', 'proj-1')
            })

            // Regrouped optimistically: gone from Recents, inside the
            // (collapsed) project; expanding reveals it
            expect(screen.queryByTestId('conv-history-item-conv-1')).not.toBeInTheDocument()
            fireEvent.click(screen.getByTestId('conv-history-project-proj-1'))
            expect(screen.getByTestId('conv-history-item-conv-1')).toBeInTheDocument()
        })

        test('removes a conversation from its project via the picker', async () => {
            setupMocks({ activeId: 'conv-p1' })
            mockGetCustomerConversations.mockResolvedValue({
                conversations: [...projectConversations, ...defaultConversations],
                lastEvaluatedKey: null,
            })
            mockGetProjects.mockResolvedValue({
                projects: [
                    { projectId: 'proj-1', name: 'Project One', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
                ],
            })
            mockUnassignFromProject.mockResolvedValue(undefined)

            render(<ConversationHistoryComponent />)

            // Project auto-expands (holds the active conversation)
            await waitFor(() => {
                expect(screen.getByTestId('conv-history-item-conv-p1')).toBeInTheDocument()
            })
            fireEvent.click(screen.getByTestId('conv-move-btn-conv-p1'))

            // Its current project is offered but disabled
            expect(screen.getByTestId('move-to-project-proj-1')).toBeDisabled()
            fireEvent.click(screen.getByTestId('remove-from-project-btn'))

            await waitFor(() => {
                expect(unassignConversationFromProject).toHaveBeenCalledWith('mock-token', 'conv-p1')
            })
            // Back in the global Recents list (project row itself remains)
            expect(screen.getByTestId('conv-history-item-conv-p1')).toBeInTheDocument()
            expect(screen.getByText('Recents')).toBeInTheDocument()
        })

        test('project rows offer a new-conversation action that starts a chat in the project', async () => {
            mockGetProjects.mockResolvedValue({
                projects: [
                    { projectId: 'proj-1', name: 'Research', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
                ],
            })

            render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-history-project-new-conv-proj-1')).toBeInTheDocument()
            })
            const btn = screen.getByTestId('conv-history-project-new-conv-proj-1')
            expect(btn).toHaveAttribute('title', 'New conversation')
            expect(btn).toHaveAttribute('aria-label', 'New conversation')
            // Permanently visible — not a hover-revealed action
            expect(btn.className).not.toContain('hoverReveal')

            fireEvent.click(btn)

            expect(mockStartConversationInProject).toHaveBeenCalledWith('proj-1')
            // The empty project row stays chevron-less (nothing to expand
            // yet); the force-expanded state is recorded so the upcoming
            // conversation renders visible once the first message creates it
            // (covered by the born-in-project test below)
            expect(screen.getByTestId('conv-history-project-proj-1')).not.toHaveAttribute('aria-expanded')
        })

        test('a conversation born in a project groups under it when its title arrives', async () => {
            setupMocks({ conversationId: 'conv-new', conversationTitle: null, pendingProjectId: 'proj-1' })
            mockGetProjects.mockResolvedValue({
                projects: [
                    { projectId: 'proj-1', name: 'Research', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
                ],
            })

            const { rerender } = render(<ConversationHistoryComponent />)

            await waitFor(() => {
                expect(screen.getByTestId('conv-history-project-proj-1')).toBeInTheDocument()
            })

            // First message sent: the title generator names the new conversation
            ;(useConversation as jest.Mock).mockReturnValue({
                conversationId: 'conv-new',
                conversationTitle: 'Fresh idea',
                pendingProjectId: 'proj-1',
                startConversationInProject: mockStartConversationInProject,
            })
            rerender(<ConversationHistoryComponent />)

            // It sits inside the (collapsed) project, not in global Recents
            expect(screen.queryByTestId('conv-history-item-conv-new')).not.toBeInTheDocument()
            fireEvent.click(screen.getByTestId('conv-history-project-proj-1'))
            expect(screen.getByTestId('conv-history-item-conv-new')).toBeInTheDocument()
            expect(screen.getAllByTestId('conv-history-item-conv-new')).toHaveLength(1)
        })
    })
})
