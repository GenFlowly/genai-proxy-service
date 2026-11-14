import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSharedItemModeration } from '../../hooks/useSharedItemModeration'
import { blockUser, getSharedItemOwner, reportContent } from '../../services/moderationService'
import { deleteConversation } from '../../services/conversationHistoryService'
import { unshareInstruction } from '../../services/instructionService'
import { CONVERSATION_LIST_CHANGED_EVENT } from '../../constants/events'

const mockRefresh = jest.fn()
const mockToast = jest.fn()
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        customerId: 'CU-ME',
        refreshInstructions: mockRefresh,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
    }),
}))
jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast: mockToast }) }))
jest.mock('../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: () => ({ isNarrow: false }) }))
jest.mock('../../services/moderationService', () => ({
    ...jest.requireActual('../../services/moderationService'),
    getSharedItemOwner: jest.fn(),
    blockUser: jest.fn(),
    reportContent: jest.fn(),
}))
jest.mock('../../services/conversationHistoryService', () => ({ deleteConversation: jest.fn() }))
jest.mock('../../services/instructionService', () => ({ unshareInstruction: jest.fn() }))

const mockOwner = getSharedItemOwner as jest.Mock
const mockBlock = blockUser as jest.Mock
const owner = { ownerCustomerId: 'CU-M', ownerUsername: 'mara', ownerName: 'Mara', canBlock: true, canRemove: true, alreadyReported: false }

function Harness({ entityType = 'CONVERSATION', enabled = true, onGone }: { entityType?: 'CONVERSATION' | 'INSTRUCTION'; enabled?: boolean; onGone: () => void }) {
    const moderation = useSharedItemModeration({ entityType, entityId: 'item-1', enabled, onGone })
    return (
        <div>
            <span data-testid="label">{moderation.ownerLabel}</span>
            {moderation.actions.map(action => <button key={action.key} data-testid={action.testId} onClick={action.onSelect}>{action.label}</button>)}
            {moderation.dialogs}
        </div>
    )
}

const renderHarness = (props: Partial<React.ComponentProps<typeof Harness>> = {}) => {
    const onGone = props.onGone ?? jest.fn()
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <Harness {...props} onGone={onGone} />
        </QueryClientProvider>
    )
    return onGone
}

describe('useSharedItemModeration', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockOwner.mockResolvedValue(owner)
        mockBlock.mockResolvedValue(undefined)
        ;(reportContent as jest.Mock).mockResolvedValue(undefined)
        ;(deleteConversation as jest.Mock).mockResolvedValue(undefined)
        ;(unshareInstruction as jest.Mock).mockResolvedValue(undefined)
    })

    test('offers nothing and asks nothing for an item you own', async () => {
        renderHarness({ enabled: false })
        await act(async () => { await Promise.resolve() })
        expect(mockOwner).not.toHaveBeenCalled()
        expect(screen.queryByTestId('conversation-report')).not.toBeInTheDocument()
    })

    test('names the owner in the actions', async () => {
        renderHarness()
        expect(await screen.findByTestId('conversation-block')).toHaveTextContent('Block @mara')
        expect(screen.getByTestId('conversation-report')).toHaveTextContent('Report conversation')
    })

    test('falls back to the name, then to "the owner"', async () => {
        mockOwner.mockResolvedValue({ ...owner, ownerUsername: null })
        renderHarness()
        await screen.findByTestId('conversation-report')
        expect(screen.getByTestId('label')).toHaveTextContent('Mara')
    })

    test('has no Block for an item with nobody behind it', async () => {
        mockOwner.mockResolvedValue({ ...owner, ownerUsername: null, ownerName: null, canBlock: false })
        renderHarness({ entityType: 'INSTRUCTION' })
        expect(await screen.findByTestId('instruction-report')).toHaveTextContent('Report instruction')
        expect(screen.queryByTestId('instruction-block')).not.toBeInTheDocument()
        expect(screen.getByTestId('label')).toHaveTextContent('the owner')
    })

    test('blocking asks first, then blocks and refreshes the lists', async () => {
        const onGone = renderHarness()
        const changed = jest.fn()
        window.addEventListener(CONVERSATION_LIST_CHANGED_EVENT, changed)
        fireEvent.click(await screen.findByTestId('conversation-block'))
        expect(mockBlock).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('block-confirm-button'))
        await waitFor(() => expect(onGone).toHaveBeenCalled())
        expect(mockBlock).toHaveBeenCalledWith('token', 'CU-M')
        expect(mockRefresh).toHaveBeenCalled()
        expect(changed).toHaveBeenCalled()
        expect(mockToast).toHaveBeenCalledWith('Blocked @mara.')
        window.removeEventListener(CONVERSATION_LIST_CHANGED_EVENT, changed)
    })

    test('a failed block keeps the dialog open with a message', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined)
        mockBlock.mockRejectedValue(new Error('nope'))
        const onGone = renderHarness()
        fireEvent.click(await screen.findByTestId('conversation-block'))
        fireEvent.click(screen.getByTestId('block-confirm-button'))
        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't block @mara. Please try again.")
        expect(onGone).not.toHaveBeenCalled()
    })

    const sendReport = async (testId: string) => {
        fireEvent.click(await screen.findByTestId(testId))
        fireEvent.click(screen.getByTestId('report-reason-SPAM'))
        fireEvent.click(screen.getByTestId('report-send'))
        await screen.findByTestId('report-sent')
    }

    test('Remove from my list leaves a conversation', async () => {
        const onGone = renderHarness()
        await sendReport('conversation-report')
        fireEvent.click(screen.getByTestId('report-remove'))
        await waitFor(() => expect(onGone).toHaveBeenCalled())
        expect(deleteConversation).toHaveBeenCalledWith('token', 'item-1')
    })

    test('Remove from my list takes you off an instruction', async () => {
        const onGone = renderHarness({ entityType: 'INSTRUCTION' })
        await sendReport('instruction-report')
        fireEvent.click(screen.getByTestId('report-remove'))
        await waitFor(() => expect(onGone).toHaveBeenCalled())
        expect(unshareInstruction).toHaveBeenCalledWith('token', 'item-1', 'CU-ME')
    })

    test('a failed Remove says so and leaves the item', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined)
        ;(deleteConversation as jest.Mock).mockRejectedValue(new Error('nope'))
        const onGone = renderHarness()
        await sendReport('conversation-report')
        fireEvent.click(screen.getByTestId('report-remove'))
        await waitFor(() => expect(mockToast).toHaveBeenCalledWith("Couldn't remove it. Please try again."))
        expect(onGone).not.toHaveBeenCalled()
    })

    test('Block on the confirmation blocks straight away', async () => {
        const onGone = renderHarness()
        await sendReport('conversation-report')
        fireEvent.click(screen.getByTestId('report-block'))
        await waitFor(() => expect(onGone).toHaveBeenCalled())
        expect(mockBlock).toHaveBeenCalledWith('token', 'CU-M')
    })
})
