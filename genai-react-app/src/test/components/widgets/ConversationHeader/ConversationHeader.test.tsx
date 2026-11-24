import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import ConversationHeader from '../../../../components/widgets/ConversationHeader/ConversationHeader'
import { LayoutProvider } from '../../../../context/LayoutContext'
import { useConversation } from '../../../../context/ConversationContext'
import { useAuth } from '../../../../context/AuthContext'
import { useAuth0 } from '@auth0/auth0-react'
import { useToast } from '../../../../context/ToastContext'
import * as conversationService from '../../../../services/conversationService'
import { ModerationError } from '../../../../services/moderationService'
import { clearHistoryCache, saveHistoryCache } from '../../../../components/widgets/ConversationHistoryWidget/historyCache'

jest.mock('../../../../context/ConversationContext')
jest.mock('../../../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}))
jest.mock('@auth0/auth0-react', () => ({
    useAuth0: jest.fn()
}))
jest.mock('../../../../context/ToastContext')
jest.mock('../../../../services/conversationService')
jest.mock('../../../../context/AIContext', () => ({
    useAI: jest.fn(),
}))
const mockModeration = jest.fn()
jest.mock('../../../../hooks/useSharedItemModeration', () => ({
    useSharedItemModeration: (options: unknown) => mockModeration(options),
}))
jest.mock('../../../../hooks/useWindowSize', () => ({
    useWindowSize: jest.fn(),
}))
const mockScrollToTurn = jest.fn()
const mockOutline = jest.fn()
jest.mock('../../../../hooks/useConversationOutline', () => ({
    useConversationOutline: () => mockOutline(),
}))
jest.mock('../../../../components/widgets/MobileHeader/MobileHeader', () => ({
    __esModule: true,
    default: ({ title, subtitle, onPillClick, pillActionLabel, pillExpanded, menuItems, menuTitle, menuAction, children }: any) => (
        <div data-testid="mobile-header">
            {onPillClick
                ? <button data-testid="mobile-pill" aria-label={pillActionLabel} aria-expanded={pillExpanded} onClick={onPillClick}>{title}<span data-testid="mobile-subtitle">{subtitle}</span></button>
                : <span>{title}<span data-testid="mobile-subtitle">{subtitle}</span></span>}
            <span data-testid="mobile-menu-title">{menuTitle}</span>
            <button data-testid="mobile-menu-action" onClick={menuAction?.onClick}>{menuAction?.label}</button>
            <ul data-testid="mobile-kebab-items">
                {(menuItems ?? []).map((item: any) => (
                    <li key={item.label}><button data-testid={item['data-testid']} onClick={item.onClick}>{item.label}</button></li>
                ))}
            </ul>
            {children}
        </div>
    ),
}))

import { useAI } from '../../../../context/AIContext'
import { useWindowSize } from '../../../../hooks/useWindowSize'

const mockUseConversation = useConversation as jest.Mock
const mockUseAuth = useAuth as jest.Mock
const mockUseAuth0 = useAuth0 as unknown as jest.Mock
const mockUseToast = useToast as jest.Mock
const mockUseAI = useAI as jest.Mock
const mockUseWindowSize = useWindowSize as jest.Mock

describe('ConversationHeader', () => {
    let showToastMock: jest.Mock
    let getAccessTokenSilentlyMock: jest.Mock

    beforeEach(() => {
        jest.clearAllMocks()
        showToastMock = jest.fn()
        getAccessTokenSilentlyMock = jest.fn().mockResolvedValue('mock-token')

        mockUseToast.mockReturnValue({
            showToast: showToastMock,
        })

        mockUseAuth0.mockReturnValue({
            getAccessTokenSilently: getAccessTokenSilentlyMock,
        })

        // Logged-in customer by default; individual tests override for logged-out cases
        mockUseAuth.mockReturnValue({
            entitlements: { canShare: true },
        })

        mockModeration.mockReturnValue({ owner: undefined, ownerLabel: '', actions: [], dialogs: null })
        mockOutline.mockReturnValue({ items: [], currentId: null, scrollToTurn: mockScrollToTurn })

        // Desktop viewport and no instruction selected by default
        mockUseWindowSize.mockReturnValue({ width: 1200, height: 800 })
        mockUseAI.mockReturnValue({
            selectedInstructionId: null,
            setSelectedInstructionId: jest.fn(),
            setSystemPrompt: jest.fn(),
        })
    })

    test('renders New Chat without a share button when conversationId is null', () => {
        mockUseConversation.mockReturnValue({
            conversationId: null,
            conversationTitle: null,
            conversationRole: null,
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByTestId('sub-bar-title')).toHaveTextContent('New Chat')
        // New Chat lives in the sidebar now; a new chat has no turns and nothing to share
        expect(screen.queryByTestId('new-chat-button')).not.toBeInTheDocument()
        expect(screen.queryByTestId('sub-bar-crumb')).not.toBeInTheDocument()
        expect(screen.queryByTestId('conversation-share-button')).not.toBeInTheDocument()
    })

    test('renders title and enabled share button when OWNER', () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'My Test Chat',
            conversationRole: 'OWNER',
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByText('My Test Chat')).toBeInTheDocument()
        const shareButton = screen.getByTestId('conversation-share-button')
        expect(shareButton).toBeInTheDocument()
        expect(shareButton).not.toBeDisabled()
    })

    test('hides share button on new chat when customer is not logged in', () => {
        mockUseAuth.mockReturnValue({
            entitlements: { canShare: false },
        })
        mockUseConversation.mockReturnValue({
            conversationId: null,
            conversationTitle: null,
            conversationRole: null,
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByTestId('sub-bar-title')).toHaveTextContent('New Chat')
        expect(screen.queryByTestId('conversation-share-button')).not.toBeInTheDocument()
    })

    test('hides share button on owned conversation when customer is not logged in', () => {
        mockUseAuth.mockReturnValue({
            entitlements: { canShare: false },
        })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'My Test Chat',
            conversationRole: 'OWNER',
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByText('My Test Chat')).toBeInTheDocument()
        expect(screen.queryByTestId('conversation-share-button')).not.toBeInTheDocument()
    })

    test('renders Untitled conversation and no share button when VIEW', () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: null,
            conversationRole: 'VIEW',
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByText('Untitled conversation')).toBeInTheDocument()
        expect(screen.queryByTestId('conversation-share-button')).not.toBeInTheDocument()
    })

    test('opens share modal and saves successfully', async () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
        })

        ;(conversationService.shareConversation as jest.Mock).mockResolvedValue({})
        ;(conversationService.unshareConversation as jest.Mock).mockResolvedValue({})
        ;(conversationService.getConversationSharedUsers as jest.Mock).mockResolvedValue([])

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        const shareButton = screen.getByTestId('conversation-share-button')
        fireEvent.click(shareButton)

        // Wait for modal to open
        await waitFor(() => {
            expect(screen.getByText('Share Options')).toBeInTheDocument()
        })

        // Simulate save from ShareModal
        // ShareModal is fully rendered, but we can't easily trigger the exact onSave with args without interacting with it.
        // It's easier to mock ShareModal, but since we didn't, let's just trigger a save via the modal UI.
        
        // Let's click "Share with only some users" to enable saving? No, "Save" is enabled if Private.
        // Wait, "Not shared (Private)" is default, Save is enabled.
        const saveButton = await screen.findByText('Save')
        fireEvent.click(saveButton)

        await waitFor(() => {
            expect(showToastMock).toHaveBeenCalledWith('Share settings updated')
        })
    })

    test('public share copies the conversation URL and shows a second toast', async () => {
        const writeTextMock = jest.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: writeTextMock },
            configurable: true,
        })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
        })
        ;(conversationService.shareConversation as jest.Mock).mockResolvedValue({})
        ;(conversationService.getConversationSharedUsers as jest.Mock).mockResolvedValue([])

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        fireEvent.click(screen.getByTestId('conversation-share-button'))
        fireEvent.click(await screen.findByLabelText('Make public to everyone'))
        fireEvent.click(await screen.findByText('Save'))

        await waitFor(() => {
            expect(showToastMock).toHaveBeenCalledWith('URL copied to clipboard')
        })
        expect(writeTextMock).toHaveBeenCalledWith(`${window.location.origin}/chat/123`)
        // Copied toast comes after/below the share confirmation
        expect(showToastMock.mock.calls.map(c => c[0])).toEqual([
            'Share settings updated',
            'URL copied to clipboard',
        ])
    })

    test('private save neither copies the URL nor shows the copied toast', async () => {
        const writeTextMock = jest.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: writeTextMock },
            configurable: true,
        })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
        })
        ;(conversationService.getConversationSharedUsers as jest.Mock).mockResolvedValue([])

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        fireEvent.click(screen.getByTestId('conversation-share-button'))
        // PRIVATE is the default mode — save directly
        fireEvent.click(await screen.findByText('Save'))

        await waitFor(() => {
            expect(showToastMock).toHaveBeenCalledWith('Share settings updated')
        })
        expect(writeTextMock).not.toHaveBeenCalled()
        expect(showToastMock).not.toHaveBeenCalledWith('URL copied to clipboard')
    })

    test('denied clipboard still leaves the share success toast', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
            configurable: true,
        })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
        })
        ;(conversationService.shareConversation as jest.Mock).mockResolvedValue({})
        ;(conversationService.getConversationSharedUsers as jest.Mock).mockResolvedValue([])

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        fireEvent.click(screen.getByTestId('conversation-share-button'))
        fireEvent.click(await screen.findByLabelText('Make public to everyone'))
        fireEvent.click(await screen.findByText('Save'))

        await waitFor(() => {
            expect(showToastMock).toHaveBeenCalledWith('Share settings updated')
        })
        expect(showToastMock).not.toHaveBeenCalledWith('URL copied to clipboard')
        expect(showToastMock).not.toHaveBeenCalledWith('Failed to update share settings')
    })

    test('shows error toast when save fails', async () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
        })

        // We need to trigger the catch block. 
        // ShareModal handles onSave. When it's private, it returns empty users and unshares initial users.
        // Let's make getAccessTokenSilently throw to trigger catch in handleShareSave.
        getAccessTokenSilentlyMock.mockRejectedValue(new Error('Auth error'))

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        fireEvent.click(screen.getByTestId('conversation-share-button'))

        const saveButton = await screen.findByText('Save')
        fireEvent.click(saveButton)

        await waitFor(() => {
            expect(showToastMock).toHaveBeenCalledWith('Failed to update share settings')
        })
    })

    test('desktop: the sub-bar shows the turn in view and the Outline jumps to a turn', () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Water heater',
            conversationRole: 'OWNER',
        })
        mockOutline.mockReturnValue({
            items: [
                { id: 'b1', number: 1, prompt: 'What fails first?', meta: '1 response · OpenAI' },
                { id: 'b2', number: 2, prompt: 'How often should I flush it?', meta: '2 responses' },
            ],
            currentId: 'b1',
            scrollToTurn: mockScrollToTurn,
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByTestId('sub-bar-title')).toHaveTextContent('Water heater')
        expect(screen.getByTestId('sub-bar-crumb')).toHaveTextContent('Q1')
        expect(screen.getByTestId('sub-bar-counter')).toHaveTextContent('1 / 2')

        fireEvent.click(screen.getByTestId('sub-bar-next'))
        expect(mockScrollToTurn).toHaveBeenLastCalledWith('b2')

        fireEvent.click(screen.getByTestId('sub-bar-crumb'))
        fireEvent.click(screen.getByTestId('outline-row-b2'))
        expect(mockScrollToTurn).toHaveBeenLastCalledWith('b2')
    })

    test('desktop: the instruction picker is not in the sub-bar (it is the editor chip)', () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.queryByTestId('choose-instruction')).not.toBeInTheDocument()
        expect(screen.queryByTestId('loaded-instruction')).not.toBeInTheDocument()
    })

    test('mobile: the pill opens the Outline sheet when there are turns', () => {
        mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Water heater',
            conversationRole: 'OWNER',
            resetConversation: jest.fn(),
        })
        mockOutline.mockReturnValue({
            items: [{ id: 'b1', number: 1, prompt: 'What fails first?' }],
            currentId: 'b1',
            scrollToTurn: mockScrollToTurn,
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        const title = screen.getByRole('button', { name: 'Outline: Water heater' })
        expect(title).toContainElement(screen.getByTestId('mobile-header-turn'))
        expect(screen.queryByTestId('outline-sheet')).not.toBeInTheDocument()
        expect(title).toHaveAttribute('aria-expanded', 'false')
        fireEvent.click(title)
        expect(screen.getByTestId('outline-sheet')).toBeInTheDocument()
        expect(title).toHaveAttribute('aria-expanded', 'true')

        fireEvent.click(screen.getByTestId('outline-row-b1'))
        expect(mockScrollToTurn).toHaveBeenCalledWith('b1')
        expect(screen.queryByTestId('outline-sheet')).not.toBeInTheDocument()
        expect(title).toHaveAttribute('aria-expanded', 'false')
    })

    test('mobile: a new chat has no Outline to open', () => {
        mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
        mockUseConversation.mockReturnValue({
            conversationId: null,
            conversationTitle: null,
            conversationRole: 'OWNER',
            resetConversation: jest.fn(),
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.queryByTestId('mobile-pill')).not.toBeInTheDocument()
        expect(screen.queryByTestId('mobile-header-turn')).not.toBeInTheDocument()
    })

    test('mobile: the kebab offers New Chat, Share and AI Settings', () => {
        mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
            resetConversation: jest.fn(),
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByTestId('mobile-kebab-items')).toHaveTextContent('New ChatShareAI Settings')
        expect(screen.getByTestId('mobile-ai-config-button')).toHaveTextContent('AI Settings')
    })

    describe('an item shared with the viewer', () => {
        const report = jest.fn()
        const shared = (role: 'VIEW' | 'EDIT' = 'VIEW') => {
            mockUseConversation.mockReturnValue({ conversationId: '123', conversationTitle: 'Test', conversationRole: role, resetConversation: jest.fn() })
            mockModeration.mockReturnValue({
                owner: { ownerCustomerId: 'CU1' },
                ownerLabel: '@mara',
                actions: [{ key: 'report', label: 'Report conversation', onSelect: report, testId: 'conversation-report' }],
                dialogs: <div data-testid="moderation-dialogs" />,
            })
        }

        test('asks for moderation only on a conversation the viewer does not own', () => {
            mockUseConversation.mockReturnValue({ conversationId: '123', conversationTitle: 'Test', conversationRole: 'OWNER', resetConversation: jest.fn() })
            render(<LayoutProvider><ConversationHeader /></LayoutProvider>)
            expect(mockModeration).toHaveBeenLastCalledWith(expect.objectContaining({ entityType: 'CONVERSATION', entityId: '123', enabled: false }))
            expect(screen.queryByTestId('shared-by')).not.toBeInTheDocument()
        })

        test('desktop: shows who shared it and the actions', () => {
            shared()
            render(<LayoutProvider><ConversationHeader /></LayoutProvider>)
            expect(mockModeration).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }))
            expect(screen.getByTestId('shared-by')).toHaveTextContent('Shared by @mara · View only')
            expect(screen.getByTestId('moderation-dialogs')).toBeInTheDocument()
            fireEvent.click(screen.getByTestId('detail-more'))
            fireEvent.click(screen.getByTestId('conversation-report'))
            expect(report).toHaveBeenCalled()
        })

        test('phone: shows who shared it, with the editor role', () => {
            mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
            shared('EDIT')
            render(<LayoutProvider><ConversationHeader /></LayoutProvider>)
            expect(screen.getByTestId('shared-by')).toHaveTextContent('Shared by @mara · Can edit')
        })
    })

    test.each([
        ['CONTENT_BLOCKED', "Can't share this. It contains language that breaks our content rules, so it stays private."],
        ['BLOCKED', "You can't share with this user."],
    ])('a share refused with %s says why', async (code, message) => {
        mockUseConversation.mockReturnValue({ conversationId: '123', conversationTitle: 'Test', conversationRole: 'OWNER', resetConversation: jest.fn() })
        ;(conversationService.getConversationSharedUsers as jest.Mock).mockResolvedValue([])
        ;(conversationService.shareConversation as jest.Mock).mockRejectedValue(new ModerationError('refused', code as 'BLOCKED'))
        jest.spyOn(console, 'error').mockImplementation(() => undefined)

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)
        fireEvent.click(screen.getByTestId('conversation-share-button'))
        fireEvent.click(await screen.findByLabelText('Make public to everyone'))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(message))
    })

    test("mobile: the slide-out menu is titled after the page's navbar item", () => {
        mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
            resetConversation: jest.fn(),
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByTestId('mobile-menu-title')).toHaveTextContent('Chat')
    })

    test('mobile: the menu action starts a new chat', () => {
        mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
        const resetConversation = jest.fn()
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
            resetConversation,
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)
        fireEvent.click(screen.getByTestId('mobile-menu-action'))

        expect(resetConversation).toHaveBeenCalled()
    })

    test('mobile: the second line is the turn in view, Q-badge, prompt and counter', () => {
        mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Kyoto trip',
            conversationRole: 'OWNER',
            resetConversation: jest.fn(),
        })
        mockOutline.mockReturnValue({
            items: [
                { id: 'b1', number: 1, prompt: 'Plan a week in Kyoto' },
                { id: 'b2', number: 2, prompt: 'Add a day trip to Nara' },
                { id: 'b3', number: 3, prompt: 'Make it cheaper' },
            ],
            currentId: 'b2',
            scrollToTurn: mockScrollToTurn,
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        const turn = screen.getByTestId('mobile-header-turn')
        expect(turn).toHaveTextContent('Q2Add a day trip to Nara2 / 3')
        expect(screen.queryByText('Choose instruction')).not.toBeInTheDocument()
        expect(screen.queryByTestId('instruction-picker-modal')).not.toBeInTheDocument()
    })

    test('mobile: the instruction is not in the header (it is the editor chip)', () => {
        mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
            resetConversation: jest.fn(),
        })
        mockUseAuth.mockReturnValue({
            entitlements: { canShare: false },
            customerInstructions: [
                { id: 'INS-1', version: 1, name: 'Smart Helper', icon: '🤖', instruction: 'x' },
            ],
        })
        mockUseAI.mockReturnValue({
            selectedInstructionId: 'INS-1',
            setSelectedInstructionId: jest.fn(),
            setSystemPrompt: jest.fn(),
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByTestId('mobile-header')).not.toHaveTextContent('Smart Helper')
        expect(screen.getByTestId('mobile-subtitle')).toBeEmptyDOMElement()
    })

    describe('a new chat started from a project', () => {
        const seedProjects = () => saveHistoryCache('cust-1', {
            items: [],
            pinned: [],
            lastKey: null,
            hasMore: false,
            projects: [{ projectId: 'proj-1', name: 'Startup', createdAt: 'c', updatedAt: 'u' }],
            projectItems: {},
        })

        beforeEach(() => {
            clearHistoryCache()
            seedProjects()
            mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
            mockUseAuth.mockReturnValue({ entitlements: { canShare: true }, customerId: 'cust-1' })
        })

        afterEach(() => clearHistoryCache())

        test('phone: the subtitle says which project', () => {
            mockUseConversation.mockReturnValue({
                conversationId: '',
                conversationTitle: null,
                conversationRole: 'OWNER',
                resetConversation: jest.fn(),
                pendingProjectId: 'proj-1',
            })
            render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

            const subtitle = screen.getByTestId('mobile-subtitle')
            expect(subtitle).toHaveTextContent(/^in Startup$/)
            expect(screen.getByTestId('mobile-header-project')).toHaveTextContent('in Startup')
        })

        test('phone: no project line once the conversation exists, or for an unknown project', () => {
            mockUseConversation.mockReturnValue({
                conversationId: 'conv-1',
                conversationTitle: 'Pitch',
                conversationRole: 'OWNER',
                resetConversation: jest.fn(),
                pendingProjectId: 'proj-1',
            })
            const { unmount } = render(<LayoutProvider><ConversationHeader /></LayoutProvider>)
            expect(screen.queryByTestId('mobile-header-project')).not.toBeInTheDocument()
            unmount()

            mockUseConversation.mockReturnValue({
                conversationId: '',
                conversationTitle: null,
                conversationRole: 'OWNER',
                resetConversation: jest.fn(),
                pendingProjectId: 'proj-gone',
            })
            render(<LayoutProvider><ConversationHeader /></LayoutProvider>)
            expect(screen.queryByTestId('mobile-header-project')).not.toBeInTheDocument()
        })
    })
})
