import React from 'react'
import { act, render, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { MemoryRouter } from 'react-router-dom'
import ChatSidebar from '../../../components/sections/ChatSidebar/ChatSidebar'
import AiSettingsDock from '../../../components/sections/AiSettingsDock/AiSettingsDock'
import ConversationHeader from '../../../components/widgets/ConversationHeader/ConversationHeader'
import { LayoutProvider, CHAT_SIDEBAR_STORAGE_KEY, AI_DOCK_STORAGE_KEY } from '../../../context/LayoutContext'

// Every icon-only control in the chat chrome (sidebar, rail, sub-bar, dock,
// strip) must have a name and show it as a tooltip on hover.

jest.mock('../../../context/ConversationContext', () => ({
    useConversation: () => ({
        conversationId: 'c1',
        conversationTitle: 'Water heater',
        conversationRole: 'OWNER',
        resetConversation: jest.fn(),
        conversationBlockList: [],
    }),
}))
jest.mock('../../../hooks/useConversationOutline', () => ({
    useConversationOutline: () => ({
        items: [
            { id: 'b1', number: 1, prompt: 'First' },
            { id: 'b2', number: 2, prompt: 'Second' },
        ],
        currentId: 'b1',
        scrollToTurn: jest.fn(),
    }),
}))
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ entitlements: { canShare: true } }) }))
jest.mock('../../../context/AIContext', () => ({
    useAI: () => ({ setSelectedInstructionId: jest.fn(), setSystemPrompt: jest.fn() }),
}))
jest.mock('../../../hooks/useLoadedInstruction', () => ({ useLoadedInstruction: () => null }))
jest.mock('../../../hooks/useSharedItemModeration', () => ({
    useSharedItemModeration: () => ({ owner: undefined, ownerLabel: '', actions: [], dialogs: null }),
}))
jest.mock('@auth0/auth0-react', () => ({ useAuth0: () => ({ getAccessTokenSilently: jest.fn() }) }))
jest.mock('../../../context/ToastContext', () => ({ useToast: () => ({ showToast: jest.fn() }) }))
jest.mock('../../../components/widgets/ConversationHistoryWidget/ConversationHistoryComponent', () => () => <div />)
jest.mock('../../../components/widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget', () => () => <section />)
jest.mock('../../../components/widgets/SidebarWidgets/AgentPickerWidget/AgentPickerWidget', () => () => <section />)
jest.mock('../../../components/widgets/SidebarWidgets/TokenCounter/TokenCounter', () => () => <section />)

const iconOnlyControls = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('button, a')).filter(el => (el.textContent ?? '').trim() === '')

const expectNamedWithTooltip = (control: HTMLElement) => {
    const name = control.getAttribute('aria-label')
    expect(name).toBeTruthy()
    act(() => { fireEvent.mouseEnter(control.parentElement!) })
    const tooltip = within(document.body).getByRole('tooltip')
    expect(tooltip).toHaveTextContent(name!)
    act(() => { fireEvent.mouseLeave(control.parentElement!) })
}

const renderChrome = () => render(
    <MemoryRouter>
        <LayoutProvider>
            <ChatSidebar />
            <ConversationHeader />
            <AiSettingsDock />
        </LayoutProvider>
    </MemoryRouter>
)

describe('chat chrome tooltips', () => {
    beforeEach(() => localStorage.clear())

    test('expanded sidebar, sub-bar and dock', () => {
        const { container } = renderChrome()
        const controls = iconOnlyControls(container)
        expect(controls.length).toBeGreaterThanOrEqual(5)
        controls.forEach(expectNamedWithTooltip)
    })

    test('rail and strip', () => {
        localStorage.setItem(CHAT_SIDEBAR_STORAGE_KEY, 'collapsed')
        localStorage.setItem(AI_DOCK_STORAGE_KEY, 'collapsed')
        const { container } = renderChrome()
        const controls = iconOnlyControls(container)
        expect(controls.length).toBeGreaterThanOrEqual(9)
        controls.forEach(expectNamedWithTooltip)
    })
})
