import React from 'react'
import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import '@testing-library/jest-dom'
import MobileHeader from '../../../../components/widgets/MobileHeader/MobileHeader'
import { useLayout } from '../../../../context/LayoutContext'

jest.mock('../../../../context/LayoutContext')

const LocationProbe = () => {
    const location = useLocation()
    return <div data-testid="location-state">{JSON.stringify(location.state)}</div>
}

const render = (ui: React.ReactElement) => rtlRender(
    <MemoryRouter initialEntries={['/chat/abc']}>
        {ui}
        <LocationProbe />
    </MemoryRouter>
)

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

    test('with an L2 Menu the hamburger toggles it', () => {
        render(<MobileHeader title="My Chat" menuContent={<div />} />)

        expect(screen.getByText('My Chat')).toBeInTheDocument()
        expect(screen.queryByTestId('mobile-header-menu-overlay')).not.toBeInTheDocument()

        fireEvent.click(screen.getByTestId('mobile-header-menu-toggle'))
        expect(mockToggleLeftSidebar).toHaveBeenCalledTimes(1)
    })

    test('without an L2 Menu the hamburger asks for the L1 Menu', () => {
        render(<MobileHeader title="Instructions" />)

        fireEvent.click(screen.getByTestId('mobile-header-menu-toggle'))

        expect(mockToggleLeftSidebar).not.toHaveBeenCalled()
        expect(screen.getByTestId('location-state')).toHaveTextContent('{"appMenu":true}')
    })

    test('without an L2 Menu an expanded sidebar opens no overlay', () => {
        mockUseLayout.mockReturnValue(layoutValue(true))

        render(<MobileHeader title="Instructions" />)

        expect(screen.queryByTestId('mobile-header-menu-overlay')).not.toBeInTheDocument()
    })

    test('the L2 Menu shows its content and its hamburger asks for the L1 Menu', () => {
        mockUseLayout.mockReturnValue(layoutValue(true))

        render(
            <MobileHeader
                title="My Chat"
                menuTitle="History"
                menuContent={<div data-testid="mock-context-content" />}
            />
        )

        expect(screen.getByTestId('mock-context-content')).toBeInTheDocument()

        fireEvent.click(screen.getByTestId('mobile-menu-app-toggle'))
        expect(screen.getByTestId('location-state')).toHaveTextContent('{"appMenu":true}')
        expect(screen.getByTestId('mock-context-content')).toBeInTheDocument()
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

        render(<MobileHeader title="My Chat" menuContent={<div />} />)

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
