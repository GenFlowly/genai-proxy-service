import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { LayoutProvider, useLayout } from '../../context/LayoutContext'

const TestComponent = () => {
    const layout = useLayout()
    return (
        <div>
            <div data-testid="left">{layout.isLeftSidebarExpanded ? 'ON' : 'OFF'}</div>
            <div data-testid="right">{layout.isRightSidebarExpanded ? 'ON' : 'OFF'}</div>
            <div data-testid="minimized">{layout.isLeftSidebarMinimized ? 'ON' : 'OFF'}</div>
            <div data-testid="history">{layout.isHistoryWidgetExpanded ? 'ON' : 'OFF'}</div>
            <div data-testid="instruction">{layout.isInstructionWidgetExpanded ? 'ON' : 'OFF'}</div>
            <button data-testid="toggle-left" onClick={layout.toggleLeftSidebar}>L</button>
            <button data-testid="toggle-right" onClick={layout.toggleRightSidebar}>R</button>
            <button data-testid="set-right-off" onClick={() => layout.setRightSidebarExpanded(false)}>RO</button>
            <button data-testid="set-left-on" onClick={() => layout.setLeftSidebarExpanded(true)}>LO</button>
            <button data-testid="minimize" onClick={() => layout.setLeftSidebarMinimized(true)}>M</button>
            <button data-testid="collapse-history" onClick={() => layout.setHistoryWidgetExpanded(false)}>H</button>
            <button data-testid="expand-instruction" onClick={() => layout.setInstructionWidgetExpanded(true)}>I</button>
        </div>
    )
}

const renderWithProvider = () =>
    render(
        <LayoutProvider>
            <TestComponent />
        </LayoutProvider>
    )

describe('LayoutContext functions', () => {
    test('toggleLeftSidebar flips the left sidebar state', () => {
        renderWithProvider()
        expect(screen.getByTestId('left')).toHaveTextContent('OFF')

        fireEvent.click(screen.getByTestId('toggle-left'))
        expect(screen.getByTestId('left')).toHaveTextContent('ON')

        fireEvent.click(screen.getByTestId('toggle-left'))
        expect(screen.getByTestId('left')).toHaveTextContent('OFF')
    })

    test('toggleRightSidebar flips the right sidebar state', () => {
        renderWithProvider()
        // jsdom window is wider than 768px, so right sidebar starts expanded
        expect(screen.getByTestId('right')).toHaveTextContent('ON')

        fireEvent.click(screen.getByTestId('toggle-right'))
        expect(screen.getByTestId('right')).toHaveTextContent('OFF')
    })

    test('setRightSidebarExpanded and setLeftSidebarExpanded set explicit values', () => {
        renderWithProvider()

        fireEvent.click(screen.getByTestId('set-right-off'))
        expect(screen.getByTestId('right')).toHaveTextContent('OFF')

        fireEvent.click(screen.getByTestId('set-left-on'))
        expect(screen.getByTestId('left')).toHaveTextContent('ON')
    })

    test('minimize, history, and instruction widget states update', () => {
        renderWithProvider()
        expect(screen.getByTestId('minimized')).toHaveTextContent('OFF')
        expect(screen.getByTestId('history')).toHaveTextContent('ON')
        expect(screen.getByTestId('instruction')).toHaveTextContent('OFF')

        fireEvent.click(screen.getByTestId('minimize'))
        fireEvent.click(screen.getByTestId('collapse-history'))
        fireEvent.click(screen.getByTestId('expand-instruction'))

        expect(screen.getByTestId('minimized')).toHaveTextContent('ON')
        expect(screen.getByTestId('history')).toHaveTextContent('OFF')
        expect(screen.getByTestId('instruction')).toHaveTextContent('ON')
    })

    test('useLayout throws outside the provider', () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
        expect(() => render(<TestComponent />)).toThrow('useLayout must be used within a LayoutProvider')
        consoleError.mockRestore()
    })
})
