import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import ConversationListWidget from '../../../../../components/widgets/CenterWidgets/ConversationListWidget/ConversationListWidget'

let mockWidgetValue: any = null
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    ConversationWidgetProvider: ({ value, children }: any) => {
        mockWidgetValue = value
        return <div data-testid="widget-provider">{children}</div>
    },
    ConversationWidget: () => <div data-testid="widget">{mockWidgetValue?.composer?.controls}</div>,
}))
jest.mock('../../../../../components/widgets/CenterWidgets/ConversationListWidget/RunHitlBanner', () => ({
    RunHitlBanner: () => null,
}))
jest.mock('../../../../../components/widgets/CenterWidgets/ConversationListWidget/InstructionChip', () => ({
    __esModule: true,
    default: ({ onClick }: { onClick: () => void }) => <button data-testid="instruction-chip" onClick={onClick}>chip</button>,
}))
jest.mock('../../../../../components/common/InstructionPickerModal/InstructionPickerModal', () => ({
    __esModule: true,
    default: ({ isOpen, onSelect, onClose }: any) => isOpen ? (
        <div data-testid="instruction-picker">
            <button data-testid="pick" onClick={() => onSelect({ id: 'I7', instruction: 'Be brief' })}>pick</button>
            <button data-testid="close" onClick={onClose}>close</button>
        </div>
    ) : null,
}))

const mockConversation = jest.fn()
jest.mock('../../../../../context/ConversationContext', () => ({
    useConversation: () => mockConversation(),
    useConversationUI: () => ({ setEditorPrompt: jest.fn(), setActiveViewportItem: jest.fn() }),
}))
jest.mock('../../../../../context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, aiVendorAPIKeyStatusList: [], getAccessTokenSilently: jest.fn() }),
}))
const mockSetSelectedInstructionId = jest.fn()
const mockSetSystemPrompt = jest.fn()
jest.mock('../../../../../context/AIContext', () => ({
    useAI: () => ({ setSelectedInstructionId: mockSetSelectedInstructionId, setSystemPrompt: mockSetSystemPrompt }),
}))
jest.mock('../../../../../context/LayoutContext', () => ({
    useLayout: () => ({ isChatSidebarExpanded: true, isAiDockExpanded: false }),
}))
jest.mock('../../../../../context/ToastContext', () => ({ useToast: () => ({ showToast: jest.fn() }) }))
jest.mock('../../../../../hooks/useVendorDisplayNames', () => ({ useVendorDisplayNames: () => (id: string) => id }))

function Location(): React.ReactElement {
    return <div data-testid="location">{useLocation().pathname}</div>
}

const renderWidget = () => render(
    <MemoryRouter initialEntries={['/chat']}>
        <Routes>
            <Route path="/chat" element={<ConversationListWidget />} />
            <Route path="*" element={<Location />} />
        </Routes>
    </MemoryRouter>
)

describe('ConversationListWidget', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockConversation.mockReturnValue({ conversationBlockList: [], conversationRole: 'OWNER' })
    })

    test('puts the instruction chip in the editor; it opens the picker, which loads the pick', () => {
        renderWidget()

        expect(mockWidgetValue.composer.canCompose).toBe(true)
        expect(mockWidgetValue.layout).toEqual({ isLeftSidebarExpanded: true, isRightSidebarExpanded: false })

        fireEvent.click(screen.getByTestId('instruction-chip'))
        fireEvent.click(screen.getByTestId('pick'))
        expect(mockSetSelectedInstructionId).toHaveBeenCalledWith('I7')
        expect(mockSetSystemPrompt).toHaveBeenCalledWith('Be brief')
        expect(screen.queryByTestId('instruction-picker')).not.toBeInTheDocument()

        fireEvent.click(screen.getByTestId('instruction-chip'))
        fireEvent.click(screen.getByTestId('close'))
        expect(screen.queryByTestId('instruction-picker')).not.toBeInTheDocument()
    })

    test('a view-only viewer gets no editor', () => {
        mockConversation.mockReturnValue({ conversationBlockList: [], conversationRole: 'VIEW' })
        renderWidget()
        expect(mockWidgetValue.composer.canCompose).toBe(false)
    })

    test('How it was inferred opens the run\'s page for the memory', () => {
        renderWidget()
        act(() => mockWidgetValue.services.openMemoryInference('MEM#a1', 'run-1'))
        expect(screen.getByTestId('location')).toHaveTextContent('/memory/MEM%23a1/inference/run-1')
    })

    test('Open in Memory opens the memory', () => {
        renderWidget()
        act(() => mockWidgetValue.services.openMemory('MEM#a1'))
        expect(screen.getByTestId('location')).toHaveTextContent('/memory/MEM%23a1')
    })

    test('Manage in Memory opens the list', () => {
        renderWidget()
        act(() => mockWidgetValue.services.openMemoryPage())
        expect(screen.getByTestId('location')).toHaveTextContent('/memory')
    })
})
