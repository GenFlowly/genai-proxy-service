import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
    LayoutProvider,
    useLayout,
    CHAT_SIDEBAR_STORAGE_KEY,
    AI_DOCK_STORAGE_KEY,
} from '../../context/LayoutContext'

const Probe = () => {
    const layout = useLayout()
    return (
        <div>
            <div data-testid="l2">{layout.isLeftSidebarExpanded ? 'ON' : 'OFF'}</div>
            <div data-testid="ai-modal">{layout.isRightSidebarExpanded ? 'ON' : 'OFF'}</div>
            <div data-testid="chat-sidebar">{layout.isChatSidebarExpanded ? 'ON' : 'OFF'}</div>
            <div data-testid="ai-dock">{layout.isAiDockExpanded ? 'ON' : 'OFF'}</div>
            <button data-testid="toggle-l2" onClick={layout.toggleLeftSidebar}>L</button>
            <button data-testid="toggle-ai-modal" onClick={layout.toggleRightSidebar}>R</button>
            <button data-testid="open-l2" onClick={() => layout.setLeftSidebarExpanded(true)}>LO</button>
            <button data-testid="close-ai-modal" onClick={() => layout.setRightSidebarExpanded(false)}>RO</button>
            <button data-testid="toggle-chat-sidebar" onClick={layout.toggleChatSidebar}>C</button>
            <button data-testid="collapse-chat-sidebar" onClick={() => layout.setChatSidebarExpanded(false)}>CC</button>
            <button data-testid="toggle-ai-dock" onClick={layout.toggleAiDock}>D</button>
            <button data-testid="collapse-ai-dock" onClick={() => layout.setAiDockExpanded(false)}>DC</button>
        </div>
    )
}

const renderProbe = () => render(<LayoutProvider><Probe /></LayoutProvider>)

describe('LayoutContext', () => {
    beforeEach(() => localStorage.clear())

    test('phone overlays start closed; desktop panels start expanded', () => {
        renderProbe()
        expect(screen.getByTestId('l2')).toHaveTextContent('OFF')
        expect(screen.getByTestId('ai-modal')).toHaveTextContent('OFF')
        expect(screen.getByTestId('chat-sidebar')).toHaveTextContent('ON')
        expect(screen.getByTestId('ai-dock')).toHaveTextContent('ON')
    })

    test('phone overlays toggle and take explicit values', () => {
        renderProbe()
        fireEvent.click(screen.getByTestId('toggle-l2'))
        expect(screen.getByTestId('l2')).toHaveTextContent('ON')
        fireEvent.click(screen.getByTestId('toggle-l2'))
        expect(screen.getByTestId('l2')).toHaveTextContent('OFF')
        fireEvent.click(screen.getByTestId('open-l2'))
        expect(screen.getByTestId('l2')).toHaveTextContent('ON')

        fireEvent.click(screen.getByTestId('toggle-ai-modal'))
        expect(screen.getByTestId('ai-modal')).toHaveTextContent('ON')
        fireEvent.click(screen.getByTestId('close-ai-modal'))
        expect(screen.getByTestId('ai-modal')).toHaveTextContent('OFF')
    })

    test('desktop panels toggle and remember their state', () => {
        renderProbe()
        fireEvent.click(screen.getByTestId('toggle-chat-sidebar'))
        fireEvent.click(screen.getByTestId('toggle-ai-dock'))
        expect(screen.getByTestId('chat-sidebar')).toHaveTextContent('OFF')
        expect(screen.getByTestId('ai-dock')).toHaveTextContent('OFF')
        expect(localStorage.getItem(CHAT_SIDEBAR_STORAGE_KEY)).toBe('collapsed')
        expect(localStorage.getItem(AI_DOCK_STORAGE_KEY)).toBe('collapsed')

        fireEvent.click(screen.getByTestId('toggle-chat-sidebar'))
        expect(localStorage.getItem(CHAT_SIDEBAR_STORAGE_KEY)).toBe('expanded')
    })

    test('a reload restores the remembered panel state', () => {
        localStorage.setItem(CHAT_SIDEBAR_STORAGE_KEY, 'collapsed')
        localStorage.setItem(AI_DOCK_STORAGE_KEY, 'collapsed')
        renderProbe()
        expect(screen.getByTestId('chat-sidebar')).toHaveTextContent('OFF')
        expect(screen.getByTestId('ai-dock')).toHaveTextContent('OFF')
    })

    test('explicit setters collapse the desktop panels', () => {
        renderProbe()
        fireEvent.click(screen.getByTestId('collapse-chat-sidebar'))
        fireEvent.click(screen.getByTestId('collapse-ai-dock'))
        expect(screen.getByTestId('chat-sidebar')).toHaveTextContent('OFF')
        expect(screen.getByTestId('ai-dock')).toHaveTextContent('OFF')
    })

    test('works when storage is unavailable', () => {
        const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
        const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
        renderProbe()
        expect(screen.getByTestId('chat-sidebar')).toHaveTextContent('ON')
        fireEvent.click(screen.getByTestId('toggle-chat-sidebar'))
        expect(screen.getByTestId('chat-sidebar')).toHaveTextContent('OFF')
        getItem.mockRestore()
        setItem.mockRestore()
    })

    test('useLayout throws outside the provider', () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
        const Orphan = () => {
            useLayout()
            return null
        }
        expect(() => render(<Orphan />)).toThrow('useLayout must be used within a LayoutProvider')
        consoleError.mockRestore()
    })
})
