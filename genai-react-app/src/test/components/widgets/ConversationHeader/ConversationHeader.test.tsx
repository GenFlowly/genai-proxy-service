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
jest.mock('../../../../hooks/useWindowSize', () => ({
    useWindowSize: jest.fn(),
}))
jest.mock('../../../../components/common/InstructionPickerModal/InstructionPickerModal', () => ({
    __esModule: true,
    default: ({ isOpen }: { isOpen: boolean }) =>
        isOpen ? <div data-testid="instruction-picker-modal" /> : null,
}))
jest.mock('../../../../components/widgets/MobileHeader/MobileHeader', () => ({
    __esModule: true,
    default: ({ title, subtitle, onSubtitleClick, children }: any) => (
        <div data-testid="mobile-header">
            <span>{title}</span>
            <button data-testid="mobile-subtitle" onClick={onSubtitleClick}>{subtitle}</button>
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

        expect(screen.getByRole('heading', { name: 'New Chat' })).toBeInTheDocument()
        expect(screen.getByTestId('new-chat-button')).toBeInTheDocument()
        // No conversation loaded yet — nothing to share
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

        expect(screen.getByRole('heading', { name: 'New Chat' })).toBeInTheDocument()
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

    test('shows Choose instruction placeholder when none is loaded and opens the picker', () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        const placeholder = screen.getByTestId('choose-instruction')
        expect(placeholder).toHaveTextContent('Choose instruction')
        expect(screen.queryByTestId('instruction-picker-modal')).not.toBeInTheDocument()

        fireEvent.click(placeholder)
        expect(screen.getByTestId('instruction-picker-modal')).toBeInTheDocument()
    })

    test('shows the latest version of the loaded instruction as a badge and opens the picker', () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
        })
        mockUseAuth.mockReturnValue({
            entitlements: { canShare: true },
            customerInstructions: [
                { id: 'INS-1', version: 1, name: 'Old Helper', icon: '🤖', instruction: 'v1' },
                { id: 'INS-1', version: 2, name: 'Smart Helper', icon: '🤖', instruction: 'v2' },
                { id: 'INS-2', version: 1, name: 'Other', instruction: 'x' },
            ],
        })
        mockUseAI.mockReturnValue({
            selectedInstructionId: 'INS-1',
            setSelectedInstructionId: jest.fn(),
            setSystemPrompt: jest.fn(),
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        const badge = screen.getByTestId('loaded-instruction')
        expect(badge).toHaveTextContent('Smart Helper')
        expect(badge).toHaveTextContent('🤖')
        expect(screen.queryByTestId('choose-instruction')).not.toBeInTheDocument()

        fireEvent.click(badge)
        expect(screen.getByTestId('instruction-picker-modal')).toBeInTheDocument()
    })

    test('renders the loaded instruction badge without an icon', () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
        })
        mockUseAuth.mockReturnValue({
            entitlements: { canShare: true },
            customerInstructions: [
                { id: 'INS-2', version: 1, name: 'Plain Persona', instruction: 'x' },
            ],
        })
        mockUseAI.mockReturnValue({
            selectedInstructionId: 'INS-2',
            setSelectedInstructionId: jest.fn(),
            setSystemPrompt: jest.fn(),
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        expect(screen.getByTestId('loaded-instruction')).toHaveTextContent('Plain Persona')
    })

    test('mobile: subtitle shows Choose instruction when none is loaded and opens the picker', () => {
        mockUseWindowSize.mockReturnValue({ width: 500, height: 800 })
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'Test',
            conversationRole: 'OWNER',
            resetConversation: jest.fn(),
        })

        render(<LayoutProvider><ConversationHeader /></LayoutProvider>)

        const subtitle = screen.getByTestId('mobile-subtitle')
        expect(subtitle).toHaveTextContent('Choose instruction')

        fireEvent.click(subtitle)
        expect(screen.getByTestId('instruction-picker-modal')).toBeInTheDocument()
    })

    test('mobile: subtitle shows the loaded instruction name', () => {
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

        expect(screen.getByTestId('mobile-subtitle')).toHaveTextContent('Smart Helper')
    })
})
