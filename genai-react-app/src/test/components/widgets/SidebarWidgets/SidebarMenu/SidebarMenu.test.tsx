import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

import SidebarMenu from '../../../../../components/widgets/SidebarWidgets/SidebarMenu/SidebarMenu'
import { useSidebarMenu } from '../../../../../context/SidebarMenuContext'
import { useLayout } from '../../../../../context/LayoutContext'

// Mock dependencies
jest.mock('../../../../../context/SidebarMenuContext')
jest.mock('../../../../../context/LayoutContext')

jest.mock('../../../../../components/common/SidebarWidgetContainer/SidebarWidgetContainer', () => {
    return function MockSidebarWidgetContainer(props) {
        return (
            <div data-testid="sidebar-widget-container" data-collapsed={props.isCollapsed}>
                <div data-testid="widget-header">{props.header}</div>
                <div data-testid="widget-content">{props.children}</div>
            </div>
        )
    }
})

jest.mock('../../../../../components/common/Tooltip/Tooltip', () => {
    return function MockTooltip(props) {
        return (
            <div data-testid="tooltip" data-content={props.content}>
                {props.children}
            </div>
        )
    }
})

// Mock the config registry
jest.mock('../../../../../config/SidebarMenuConfig', () => {
    const originalModule = jest.requireActual('../../../../../config/SidebarMenuConfig')
    return {
        ...originalModule,
        SIDEBAR_MENU_REGISTRY: [
            {
                pageId: 'TEST_PAGE_ID',
                header: 'Test Header',
                items: [
                    { widgetId: 'TEST_WIDGET_1', label: 'First Widget' },
                    { widgetId: 'TEST_WIDGET_2', label: 'Second Widget' }
                ]
            }
        ]
    }
})

describe('SidebarMenu', () => {
    const mockSetActiveWidgetId = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks();

        // Default mock implementations
        (useSidebarMenu as jest.Mock).mockReturnValue({
            activeWidgetId: 'TEST_WIDGET_1',
            setActiveWidgetId: mockSetActiveWidgetId,
            pageId: 'TEST_PAGE_ID'
        });

        (useLayout as jest.Mock).mockReturnValue({
            isLeftSidebarExpanded: true
        });
    })

    test('renders header and menu items based on config mapping', () => {
        render(<SidebarMenu />)

        // Verifies header
        expect(screen.getByText('Test Header')).toBeInTheDocument()

        // Verifies labels
        expect(screen.getByText('First Widget')).toBeInTheDocument()
        expect(screen.getByText('Second Widget')).toBeInTheDocument()

        // By default, no tooltips because the sidebar is expanded
        expect(screen.queryByTestId('tooltip')).not.toBeInTheDocument()
    })

    test('applies "active" class to the correct item based on activeWidgetId', () => {
        const { unmount } = render(<SidebarMenu />)

        let firstButton = screen.getByText('First Widget').closest('button')
        let secondButton = screen.getByText('Second Widget').closest('button')
        
        expect(firstButton).toHaveClass('active')
        expect(secondButton).not.toHaveClass('active')

        unmount();

        (useSidebarMenu as jest.Mock).mockReturnValue({
            activeWidgetId: 'TEST_WIDGET_2',
            setActiveWidgetId: mockSetActiveWidgetId,
            pageId: 'TEST_PAGE_ID'
        });

        render(<SidebarMenu />)
        
        firstButton = screen.getByText('First Widget').closest('button')
        secondButton = screen.getByText('Second Widget').closest('button')

        expect(firstButton).not.toHaveClass('active')
        expect(secondButton).toHaveClass('active')
    })

    test('calls setActiveWidgetId when a menu item is clicked', () => {
        render(<SidebarMenu />)

        const secondButton = screen.getByText('Second Widget').closest('button')
        fireEvent.click(secondButton!)

        expect(mockSetActiveWidgetId).toHaveBeenCalledWith('TEST_WIDGET_2')
        expect(mockSetActiveWidgetId).toHaveBeenCalledTimes(1)
    })

    test('renders tooltips when left sidebar is collapsed', () => {
        (useLayout as jest.Mock).mockReturnValue({
            isLeftSidebarExpanded: false
        });

        render(<SidebarMenu />)

        const tooltips = screen.getAllByTestId('tooltip')
        expect(tooltips).toHaveLength(2)

        expect(tooltips[0]).toHaveAttribute('data-content', 'First Widget')
        expect(tooltips[1]).toHaveAttribute('data-content', 'Second Widget')
    })

    test('passes expanded state down to the SidebarWidgetContainer', () => {
        const { unmount } = render(<SidebarMenu />)
        let container = screen.getByTestId('sidebar-widget-container')
        expect(container).toHaveAttribute('data-collapsed', 'false')
        unmount();

        (useLayout as jest.Mock).mockReturnValue({
            isLeftSidebarExpanded: false
        });
        render(<SidebarMenu />)
        container = screen.getByTestId('sidebar-widget-container')
        expect(container).toHaveAttribute('data-collapsed', 'true')
    })

    test('renders nothing gracefully if pageId is missing from context', () => {
        (useSidebarMenu as jest.Mock).mockReturnValue({
            activeWidgetId: null,
            setActiveWidgetId: mockSetActiveWidgetId,
            pageId: null
        });

        render(<SidebarMenu />)
        
        // No labels or tooltips should exist
        expect(screen.queryByText('First Widget')).not.toBeInTheDocument()
        expect(screen.queryByTestId('tooltip')).not.toBeInTheDocument()
    })
})
