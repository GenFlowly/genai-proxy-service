import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import MobileHeader from '../../../../components/widgets/MobileHeader/MobileHeader'
import { useLayout } from '../../../../context/LayoutContext'

jest.mock('../../../../context/LayoutContext')
jest.mock('../../../../components/sections/LeftSidebar/AppMenuContent', () => ({
    AppMenuContent: () => <div data-testid="mock-app-menu-content" />
}))

const mockUseLayout = useLayout as jest.Mock

describe('MobileHeader', () => {
    const mockToggleLeftSidebar = jest.fn()
    const mockSetLeftSidebarExpanded = jest.fn()

    const layoutValue = (expanded: boolean) => ({
        isLeftSidebarExpanded: expanded,
        toggleLeftSidebar: mockToggleLeftSidebar,
        setLeftSidebarExpanded: mockSetLeftSidebarExpanded,
    })

    beforeEach(() => {
        jest.clearAllMocks()
        mockUseLayout.mockReturnValue(layoutValue(false))
    })

    test('renders title and opens the mobile menu from the hamburger', () => {
        render(<MobileHeader title="My Chat" />)

        expect(screen.getByText('My Chat')).toBeInTheDocument()
        expect(screen.queryByTestId('mobile-header-menu-overlay')).not.toBeInTheDocument()

        fireEvent.click(screen.getByTestId('mobile-header-menu-toggle'))
        expect(mockToggleLeftSidebar).toHaveBeenCalledTimes(1)
    })

    test('without page context the menu opens straight to the app menu', () => {
        mockUseLayout.mockReturnValue(layoutValue(true))

        render(<MobileHeader title="My Chat" />)

        expect(screen.getByTestId('mobile-header-menu-overlay')).toBeInTheDocument()
        expect(screen.getByTestId('mock-app-menu-content')).toBeInTheDocument()
        expect(screen.queryByTestId('mobile-menu-back')).not.toBeInTheDocument()
    })

    test('with page context the menu shows it first, then drills into the app menu', () => {
        mockUseLayout.mockReturnValue(layoutValue(true))

        render(
            <MobileHeader
                title="My Chat"
                menuTitle="History"
                menuContent={<div data-testid="mock-context-content" />}
            />
        )

        expect(screen.getByTestId('mock-context-content')).toBeInTheDocument()
        expect(screen.queryByTestId('mock-app-menu-content')).not.toBeInTheDocument()

        fireEvent.click(screen.getByTestId('mobile-menu-app-toggle'))
        expect(screen.getByTestId('mock-app-menu-content')).toBeInTheDocument()
        expect(screen.queryByTestId('mock-context-content')).not.toBeInTheDocument()
    })

    test('passes the page action to the menu', () => {
        mockUseLayout.mockReturnValue(layoutValue(true))
        const onClick = jest.fn()

        render(
            <MobileHeader
                title="My Chat"
                menuTitle="History"
                menuAction={{ label: 'New chat', onClick, 'data-testid': 'menu-action' }}
                menuContent={<div />}
            />
        )

        fireEvent.click(screen.getByTestId('menu-action'))
        expect(onClick).toHaveBeenCalled()
    })

    test('closing the menu collapses the left sidebar', () => {
        mockUseLayout.mockReturnValue(layoutValue(true))

        render(<MobileHeader title="My Chat" />)

        fireEvent.click(screen.getByTestId('mobile-menu-close'))
        expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(false)
    })

    test('renders a tappable subtitle that fires onSubtitleClick', () => {
        const onSubtitleClick = jest.fn()
        render(<MobileHeader title="My Chat" subtitle="Coding Buddy" onSubtitleClick={onSubtitleClick} />)

        fireEvent.click(screen.getByTestId('mobile-header-subtitle'))
        expect(onSubtitleClick).toHaveBeenCalledTimes(1)
    })

    test('renders a plain subtitle when there is no click handler', () => {
        render(<MobileHeader title="My Note" subtitle="Saved at 10:00" />)

        const subtitle = screen.getByTestId('mobile-header-subtitle')
        expect(subtitle).toHaveTextContent('Saved at 10:00')
        expect(subtitle.tagName).not.toBe('BUTTON')
    })

    test('kebab opens the menu; picking an item fires it and closes the menu', () => {
        const onNewChat = jest.fn()
        render(
            <MobileHeader
                title="My Chat"
                menuItems={[{ label: 'New Chat', onClick: onNewChat, 'data-testid': 'menu-new-chat' }]}
            />
        )

        expect(screen.queryByTestId('mobile-header-kebab-menu')).not.toBeInTheDocument()
        fireEvent.click(screen.getByTestId('mobile-header-kebab'))
        expect(screen.getByTestId('mobile-header-kebab-menu')).toBeInTheDocument()

        fireEvent.click(screen.getByTestId('menu-new-chat'))
        expect(onNewChat).toHaveBeenCalledTimes(1)
        expect(screen.queryByTestId('mobile-header-kebab-menu')).not.toBeInTheDocument()
    })

    test('disabled menu items do not fire', () => {
        const onShare = jest.fn()
        render(
            <MobileHeader
                title="My Chat"
                menuItems={[{ label: 'Share', onClick: onShare, disabled: true, 'data-testid': 'menu-share' }]}
            />
        )

        fireEvent.click(screen.getByTestId('mobile-header-kebab'))
        const shareItem = screen.getByTestId('menu-share')
        expect(shareItem).toBeDisabled()
        fireEvent.click(shareItem)
        expect(onShare).not.toHaveBeenCalled()
    })

    test('hides the kebab when there are no menu items', () => {
        render(<MobileHeader title="My Chat" />)
        expect(screen.queryByTestId('mobile-header-kebab')).not.toBeInTheDocument()
    })
})
