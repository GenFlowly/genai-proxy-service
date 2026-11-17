import React from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import NewChatProjectHint from '../../../../../components/widgets/CenterWidgets/ConversationListWidget/NewChatProjectHint'
import { useConversation } from '../../../../../context/ConversationContext'
import { useAuth } from '../../../../../context/AuthContext'
import { useWindowSize } from '../../../../../hooks/useWindowSize'
import { clearHistoryCache, saveHistoryCache } from '../../../../../components/widgets/ConversationHistoryWidget/historyCache'

jest.mock('../../../../../context/ConversationContext')
jest.mock('../../../../../context/AuthContext', () => ({ useAuth: jest.fn() }))
jest.mock('../../../../../hooks/useWindowSize', () => ({ useWindowSize: jest.fn() }))

const draft = { conversationBlockId: 'b1', status: 'draft', isLoading: false, responseMessages: [] }

const conversation = (overrides: Record<string, unknown> = {}) =>
    (useConversation as jest.Mock).mockReturnValue({
        conversationId: '',
        pendingProjectId: 'proj-1',
        conversationBlockList: [draft],
        ...overrides,
    })

describe('NewChatProjectHint', () => {
    beforeEach(() => {
        clearHistoryCache()
        saveHistoryCache('cust-1', {
            items: [],
            pinned: [],
            lastKey: null,
            hasMore: false,
            projects: [{ projectId: 'proj-1', name: 'Startup', createdAt: 'c', updatedAt: 'u' }],
            projectItems: {},
        })
        ;(useAuth as jest.Mock).mockReturnValue({ customerId: 'cust-1' })
        ;(useWindowSize as jest.Mock).mockReturnValue({ width: 390, height: 844 })
    })

    afterEach(() => clearHistoryCache())

    test('phone: says where the new chat will go', () => {
        conversation()
        render(<NewChatProjectHint />)
        expect(screen.getByTestId('new-chat-project-hint')).toHaveTextContent(
            'Your first message starts a chat in the Startup project. It will show up under Startup in the menu.'
        )
    })

    test('gone once the first message is on its way', () => {
        conversation({ conversationBlockList: [{ ...draft, isLoading: true }] })
        render(<NewChatProjectHint />)
        expect(screen.queryByTestId('new-chat-project-hint')).not.toBeInTheDocument()
    })

    test('not on desktop, not without a pending project, not once the conversation exists', () => {
        ;(useWindowSize as jest.Mock).mockReturnValue({ width: 1440, height: 900 })
        conversation()
        const { unmount } = render(<NewChatProjectHint />)
        expect(screen.queryByTestId('new-chat-project-hint')).not.toBeInTheDocument()
        unmount()

        ;(useWindowSize as jest.Mock).mockReturnValue({ width: 390, height: 844 })
        conversation({ pendingProjectId: null })
        const second = render(<NewChatProjectHint />)
        expect(screen.queryByTestId('new-chat-project-hint')).not.toBeInTheDocument()
        second.unmount()

        conversation({ conversationId: 'conv-1' })
        render(<NewChatProjectHint />)
        expect(screen.queryByTestId('new-chat-project-hint')).not.toBeInTheDocument()
    })
})
