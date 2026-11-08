import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { SlidePanel } from '../../../../components/common/SlidePanel/SlidePanel'

interface FakeAnimation {
    keyframes: Keyframe[]
    finish: () => void
    cancel: jest.Mock
    finished: Promise<void>
}

/** jsdom has no Web Animations; these finish when a test says so. */
let animations: FakeAnimation[] = []

function installAnimate() {
    animations = []
    Object.defineProperty(HTMLElement.prototype, 'animate', {
        configurable: true,
        value: jest.fn(function (keyframes: Keyframe[]) {
            let finish = () => {}
            let cancel = () => {}
            const finished = new Promise<void>((resolve, reject) => {
                finish = resolve
                cancel = () => reject(new DOMException('Aborted', 'AbortError'))
            })
            const animation = { keyframes, finish, cancel: jest.fn(cancel), finished }
            animations.push(animation)
            return animation
        }),
    })
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
        configurable: true,
        value: () => animations,
    })
}

function uninstallAnimate() {
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate
    delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations
}

const renderPanel = (open: boolean, appearInPlace = false) => (
    <SlidePanel layer="l2" open={open} appearInPlace={appearInPlace}>
        <div data-testid="menu" />
    </SlidePanel>
)

describe('SlidePanel', () => {
    afterEach(uninstallAnimate)

    test('closed, it renders nothing', () => {
        render(renderPanel(false))
        expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
    })

    test('without animations it opens and closes at once', () => {
        const { rerender } = render(renderPanel(false))

        rerender(renderPanel(true))
        expect(screen.getByTestId('menu')).toBeInTheDocument()

        rerender(renderPanel(false))
        expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
    })

    test('it marks its layer for the edge swipe', () => {
        render(renderPanel(true))
        expect(screen.getByTestId('slide-panel-l2')).toHaveAttribute('data-swipe-layer', 'l2')
    })

    describe('with animations', () => {
        beforeEach(installAnimate)

        test('opening slides it in from off-screen left and leaves no transform behind', () => {
            const { rerender } = render(renderPanel(false))

            rerender(renderPanel(true))

            expect(animations).toHaveLength(1)
            expect(animations[0].keyframes).toEqual([{ transform: 'translateX(-100%)' }, { transform: 'none' }])
            expect(screen.getByTestId('slide-panel-l2').style.transform).toBe('')
        })

        test('already open when it mounts, it has nothing to slide in over', () => {
            render(renderPanel(true))
            expect(animations).toHaveLength(0)
        })

        test('appearing in place under a menu that slides away, it does not move', () => {
            const { rerender } = render(renderPanel(false, true))

            rerender(renderPanel(true, true))

            expect(animations).toHaveLength(0)
            expect(screen.getByTestId('menu')).toBeInTheDocument()
        })

        test('closing slides it out to the left before it goes', async () => {
            const { rerender } = render(renderPanel(true))

            rerender(renderPanel(false))

            expect(animations[0].keyframes).toEqual([{ transform: 'none' }, { transform: 'translateX(-100%)' }])
            expect(screen.getByTestId('menu')).toBeInTheDocument()

            await act(async () => { animations[0].finish() })
            expect(screen.queryByTestId('menu')).not.toBeInTheDocument()
        })

        test('reopened while it slides out, it turns around and stays', async () => {
            const { rerender } = render(renderPanel(true))
            rerender(renderPanel(false))
            const leaving = animations[0]

            rerender(renderPanel(true))

            expect(leaving.cancel).toHaveBeenCalled()
            await act(async () => { await leaving.finished.catch(() => undefined) })
            expect(screen.getByTestId('menu')).toBeInTheDocument()
            expect(animations[1].keyframes[1]).toEqual({ transform: 'none' })
        })

        test('reopened in place while it slides out, it is back at once', async () => {
            const { rerender } = render(renderPanel(true, true))
            rerender(renderPanel(false, true))

            rerender(renderPanel(true, true))

            expect(animations[0].cancel).toHaveBeenCalled()
            await act(async () => { await animations[0].finished.catch(() => undefined) })
            expect(screen.getByTestId('menu')).toBeInTheDocument()
            expect(screen.getByTestId('slide-panel-l2').style.transform).toBe('')
        })
    })
})
