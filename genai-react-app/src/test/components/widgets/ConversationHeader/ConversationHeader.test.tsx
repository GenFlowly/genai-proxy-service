import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import ConversationHeader from '../../../../components/widgets/ConversationHeader/ConversationHeader'
import { useConversation } from '../../../../context/ConversationContext'
import { useAuth0 } from '@auth0/auth0-react'
import { useToast } from '../../../../context/ToastContext'
import * as conversationService from '../../../../services/conversationService'

jest.mock('../../../../context/ConversationContext')
jest.mock('@auth0/auth0-react', () => ({
    useAuth0: jest.fn()
}))
jest.mock('../../../../context/ToastContext')
jest.mock('../../../../services/conversationService')

const mockUseConversation = useConversation as jest.Mock
const mockUseAuth0 = useAuth0 as unknown as jest.Mock
const mockUseToast = useToast as jest.Mock

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
    })

    test('renders New Chat and disabled share button when conversationId is null', () => {
        mockUseConversation.mockReturnValue({
            conversationId: null,
            conversationTitle: null,
            conversationRole: null,
        })

        render(<ConversationHeader />)

        expect(screen.getByText('New Chat')).toBeInTheDocument()
        const shareButton = screen.getByTestId('conversation-share-button')
        expect(shareButton).toBeInTheDocument()
        expect(shareButton).toBeDisabled()
    })

    test('renders title and enabled share button when OWNER', () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: 'My Test Chat',
            conversationRole: 'OWNER',
        })

        render(<ConversationHeader />)

        expect(screen.getByText('My Test Chat')).toBeInTheDocument()
        const shareButton = screen.getByTestId('conversation-share-button')
        expect(shareButton).toBeInTheDocument()
        expect(shareButton).not.toBeDisabled()
    })

    test('renders Untitled conversation and no share button when VIEW', () => {
        mockUseConversation.mockReturnValue({
            conversationId: '123',
            conversationTitle: null,
            conversationRole: 'VIEW',
        })

        render(<ConversationHeader />)

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

        render(<ConversationHeader />)

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

        render(<ConversationHeader />)

        fireEvent.click(screen.getByTestId('conversation-share-button'))

        const saveButton = await screen.findByText('Save')
        fireEvent.click(saveButton)

        await waitFor(() => {
            expect(showToastMock).toHaveBeenCalledWith('Failed to update share settings')
        })
    })
})
