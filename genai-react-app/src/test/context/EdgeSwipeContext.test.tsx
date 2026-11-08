import React from 'react'
import { createPortal } from 'react-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom'
import { EdgeSwipeProvider, MenuLayer, useEdgeSwipePageAction } from '../../context/EdgeSwipeContext'
import { SlidePanel } from '../../components/common/SlidePanel/SlidePanel'
import { useLayout } from '../../context/LayoutContext'
import { MenuLocationState, OPEN_L2_MENU_STATE } from '../../hooks/useAppMenu'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'

jest.mock('../../context/LayoutContext', () => ({ useLayout: jest.fn() }))
jest.mock('../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: jest.fn() }))

const SCREEN_WIDTH = 390
const mockSetLeftSidebarExpanded = jest.fn()

const LocationProbe = () => {
    const location = useLocation()
    const navigationType = useNavigationType()
    return (
        <>
            <div data-testid="location">{location.pathname} {JSON.stringify(location.state)}</div>
            <div data-testid="navigation-type">{navigationType}</div>
        </>
    )
}

interface PageProps {
    menuLayer?: MenuLayer
    backTo?: string
    backState?: MenuLocationState
    isL2Open?: boolean
    children?: React.ReactNode
}

/** A page whose header registers its top-left button, with its L2 Menu. */
const Page = ({ menuLayer = 'l2', backTo, backState, isL2Open = false, children }: PageProps) => {
    useEdgeSwipePageAction(menuLayer, backTo ? { to: backTo, state: backState } : undefined)
    return (
        <div data-testid="page">
            {children}
            <SlidePanel layer="l2" open={isL2Open}>
                <div role="dialog" aria-modal="true" data-testid="l2-menu">
                    <div data-testid="l2-row" />
                    <div role="dialog" aria-modal="true" data-testid="l2-inner-dialog" />
                </div>
            </SlidePanel>
        </div>
    )
}

let appRoot: HTMLElement

function renderApp(page: React.ReactElement) {
    return render(
        <MemoryRouter initialEntries={['/chat/abc']}>
            <EdgeSwipeProvider>
                {page}
                <SlidePanel layer="l1" open={false}>
                    <div data-testid="l1-menu" />
                </SlidePanel>
                <LocationProbe />
            </EdgeSwipeProvider>
        </MemoryRouter>,
        { container: appRoot }
    )
}

/** A one-finger swipe, one step every 16ms unless a step says otherwise. */
function swipe(target: Element, points: Array<[number, number, number?]>, end: 'touchEnd' | 'touchCancel' = 'touchEnd') {
    const [[startX, startY], ...moves] = points
    fireEvent.touchStart(target, { touches: [{ clientX: startX, clientY: startY }] })
    moves.forEach(([clientX, clientY, delay = 16]) => {
        act(() => { jest.advanceTimersByTime(delay) })
        fireEvent.touchMove(target, { touches: [{ clientX, clientY }] })
    })
    fireEvent[end](target, { touches: [] })
}

/** Slow enough that only the distance decides. */
const slowly = (x: number, y = 300): [number, number, number] => [x, y, 500]

describe('EdgeSwipeProvider', () => {
    beforeEach(() => {
        jest.useFakeTimers()
        jest.clearAllMocks()
        window.innerWidth = SCREEN_WIDTH
        ;(useLayout as jest.Mock).mockReturnValue({ setLeftSidebarExpanded: mockSetLeftSidebarExpanded })
        ;(useResponsiveBreakpoints as jest.Mock).mockReturnValue({ isNarrow: true })
        appRoot = document.createElement('div')
        appRoot.id = 'root'
        document.body.appendChild(appRoot)
    })

    afterEach(() => {
        appRoot.remove()
        window.innerWidth = 1280
        jest.useRealTimers()
    })

    test('a swipe from the left edge drags the page\'s L2 Menu in under the finger', () => {
        renderApp(<Page />)
        const page = screen.getByTestId('page')

        fireEvent.touchStart(page, { touches: [{ clientX: 4, clientY: 300 }] })
        fireEvent.touchMove(page, { touches: [{ clientX: 104, clientY: 302 }] })

        const panel = screen.getByTestId('slide-panel-l2')
        expect(panel.style.transform).toBe(`translateX(${100 - SCREEN_WIDTH}px)`)
        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('released past a third of the screen it opens the L2 Menu', () => {
        renderApp(<Page />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(60), slowly(200)])

        expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(true)
    })

    test('released early it slides back and opens nothing', () => {
        renderApp(<Page />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(40), slowly(80)])

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
        expect(screen.queryByTestId('l2-menu')).not.toBeInTheDocument()
    })

    test('a quick flick opens it however short', () => {
        renderApp(<Page />)

        swipe(screen.getByTestId('page'), [[4, 300], [30, 300], [70, 300, 20]])

        expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(true)
    })

    test('a page without an L2 Menu opens the L1 Menu over itself', () => {
        renderApp(<Page menuLayer="l1" />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(60), slowly(200)])

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
        expect(screen.getByTestId('location')).toHaveTextContent('/chat/abc {"appMenu":true}')
    })

    test('on the L2 Menu it opens the L1 Menu', () => {
        renderApp(<Page isL2Open />)

        swipe(screen.getByTestId('l2-row'), [[4, 300], slowly(60), slowly(200)])

        expect(screen.getByTestId('location')).toHaveTextContent('{"appMenu":true}')
        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('the swiped-in L1 Menu takes over the page\'s history entry, which Back would otherwise skip', () => {
        renderApp(<Page menuLayer="l1" />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(60), slowly(200)])

        expect(screen.getByTestId('navigation-type')).toHaveTextContent('REPLACE')
    })

    test('a page with a Back link goes back instead', () => {
        renderApp(<Page backTo="/memory/m1" />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(60), slowly(200)])

        expect(screen.getByTestId('location')).toHaveTextContent('/memory/m1')
        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
        expect(screen.queryByTestId('l2-menu')).not.toBeInTheDocument()
    })

    test('going back can arrive with a menu request, to land on the menu the page was opened from', () => {
        renderApp(<Page backTo="/settings/profile" backState={OPEN_L2_MENU_STATE} />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(60), slowly(200)])

        expect(screen.getByTestId('location')).toHaveTextContent('/settings/profile {"openMobileMenu":true}')
    })

    test('a short swipe on a page with a Back link stays put', () => {
        renderApp(<Page backTo="/memory/m1" />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(40), slowly(80)])

        expect(screen.getByTestId('location')).toHaveTextContent('/chat/abc')
    })

    test('on the L1 Menu it does nothing: L1 is the top', () => {
        renderApp(
            <>
                <Page />
                <SlidePanel layer="l1" open>
                    <div data-testid="open-l1-menu" />
                </SlidePanel>
            </>
        )

        swipe(screen.getByTestId('open-l1-menu'), [[4, 300], slowly(60), slowly(200)])

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
        expect(screen.getByTestId('location')).toHaveTextContent('/chat/abc null')
    })

    test('a touch that starts away from the edge is left alone', () => {
        renderApp(<Page />)

        swipe(screen.getByTestId('page'), [[60, 300], slowly(120), slowly(300)])

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('a mostly vertical drag stays a scroll', () => {
        renderApp(<Page />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(20, 360), slowly(200, 600)])

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('a dialog raised inside the L2 Menu keeps its touches', () => {
        renderApp(<Page isL2Open />)

        swipe(screen.getByTestId('l2-inner-dialog'), [[4, 300], slowly(60), slowly(200)])

        expect(screen.getByTestId('location')).toHaveTextContent('/chat/abc null')
    })

    test('a dialog over the page keeps its touches', () => {
        renderApp(<Page><div role="dialog" aria-modal="true" data-testid="sheet" /></Page>)

        swipe(screen.getByTestId('sheet'), [[4, 300], slowly(60), slowly(200)])

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('content portaled out of the app root keeps its touches', () => {
        renderApp(<Page>{createPortal(<div data-testid="modal" />, document.body)}</Page>)

        swipe(screen.getByTestId('modal'), [[4, 300], slowly(60), slowly(200)])

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('content scrolled sideways scrolls back instead', () => {
        renderApp(<Page><div data-testid="table" style={{ overflowX: 'auto' }} /></Page>)
        const table = screen.getByTestId('table')
        table.scrollLeft = 40

        swipe(table, [[4, 300], slowly(60), slowly(200)])

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('a touch the browser takes over opens nothing', () => {
        renderApp(<Page />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(60), slowly(200)], 'touchCancel')

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('two fingers are not a swipe', () => {
        renderApp(<Page />)
        const page = screen.getByTestId('page')

        fireEvent.touchStart(page, { touches: [{ clientX: 4, clientY: 300 }, { clientX: 200, clientY: 300 }] })
        act(() => { jest.advanceTimersByTime(500) })
        fireEvent.touchMove(page, { touches: [{ clientX: 200, clientY: 300 }] })
        fireEvent.touchEnd(page, { touches: [] })

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('the swipe ends editing so the keyboard is not left over the menu', () => {
        renderApp(<Page><input data-testid="composer" /></Page>)
        const composer = screen.getByTestId('composer')
        composer.focus()

        swipe(screen.getByTestId('page'), [[4, 300], slowly(60), slowly(200)])

        expect(composer).not.toHaveFocus()
    })

    test('wider screens have no edge swipe', () => {
        ;(useResponsiveBreakpoints as jest.Mock).mockReturnValue({ isNarrow: false })
        renderApp(<Page />)

        swipe(screen.getByTestId('page'), [[4, 300], slowly(60), slowly(200)])

        expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
    })

    test('a page that leaves takes its action with it', () => {
        const { rerender } = renderApp(<Page backTo="/memory/m1" />)
        rerender(
            <MemoryRouter initialEntries={['/chat/abc']}>
                <EdgeSwipeProvider>
                    <div data-testid="bare-page" />
                    <LocationProbe />
                </EdgeSwipeProvider>
            </MemoryRouter>
        )

        swipe(screen.getByTestId('bare-page'), [[4, 300], slowly(60), slowly(200)])

        expect(screen.getByTestId('location')).toHaveTextContent('/chat/abc')
    })
})
