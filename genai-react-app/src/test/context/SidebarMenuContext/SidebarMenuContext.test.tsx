import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { SidebarMenuProvider, useSidebarMenu } from '../../../context/SidebarMenuContext'

const TestComponent = () => {
    const { activeWidgetId, setActiveWidgetId, pageId } = useSidebarMenu()
    return (
        <div>
            <div data-testid="active-id">{activeWidgetId || 'null'}</div>
            <div data-testid="page-id">{pageId || 'null'}</div>
            <button onClick={() => setActiveWidgetId('new-widget')}>Change Widget</button>
        </div>
    )
}

describe('SidebarMenuContext', () => {
    test('provides initial values correctly', () => {
        render(
            <SidebarMenuProvider pageId="CHAT_PAGE" initialWidgetId="init-widget">
                <TestComponent />
            </SidebarMenuProvider>
        )

        expect(screen.getByTestId('active-id').textContent).toBe('init-widget')
        expect(screen.getByTestId('page-id').textContent).toBe('CHAT_PAGE')
    })

    test('updates active widget id', () => {
        render(
            <SidebarMenuProvider pageId="CHAT_PAGE">
                <TestComponent />
            </SidebarMenuProvider>
        )

        const button = screen.getByText('Change Widget')
        act(() => {
            button.click()
        })

        expect(screen.getByTestId('active-id').textContent).toBe('new-widget')
    })

    test('returns default values when used outside provider', () => {
        render(<TestComponent />)

        expect(screen.getByTestId('active-id').textContent).toBe('null')
        expect(screen.getByTestId('page-id').textContent).toBe('null')
    })
})
