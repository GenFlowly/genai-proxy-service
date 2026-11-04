import React from 'react'
import { render, screen } from '@testing-library/react'
import { useTapOutsideEndsEditing } from '../../hooks/useTapOutsideEndsEditing'

const Page = () => {
    useTapOutsideEndsEditing()
    return (
        <div>
            <p data-testid="blank">Blank space</p>
            <button data-testid="button">Button</button>
            <input data-testid="text" />
            <input data-testid="other-text" />
            <input data-testid="checkbox" type="checkbox" />
            <textarea data-testid="textarea" />
            <label data-testid="label">Label</label>
            <select data-testid="select"><option>One</option></select>
            <div className="cm-editor">
                <div data-testid="editor" contentEditable suppressContentEditableWarning tabIndex={0}>Text</div>
                <div className="cm-tooltip"><span data-testid="completion">div</span></div>
            </div>
        </div>
    )
}

const send = (target: Element, type: string, init: Record<string, unknown>) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { pointerId: 1, clientX: 100, clientY: 100, pointerType: 'touch', ...init })
    target.dispatchEvent(event)
}

const tap = (target: Element, init: Record<string, unknown> = {}) => {
    send(target, 'pointerdown', init)
    send(target, 'pointerup', init)
}

const typingIn = (testId: string) => {
    const field = screen.getByTestId(testId)
    field.focus()
    expect(document.activeElement).toBe(field)
    return field
}

describe('useTapOutsideEndsEditing', () => {
    beforeEach(() => {
        render(<Page />)
    })

    test.each(['blank', 'button'])('a tap on %s closes the keyboard', target => {
        const field = typingIn('text')
        tap(screen.getByTestId(target))
        expect(document.activeElement).not.toBe(field)
    })

    test.each(['textarea', 'editor'])('it works from a %s too', source => {
        const field = typingIn(source)
        tap(screen.getByTestId('blank'))
        expect(document.activeElement).not.toBe(field)
    })

    test.each(['text', 'other-text', 'checkbox', 'textarea', 'label', 'select', 'editor', 'completion'])(
        'a tap on %s keeps the keyboard up',
        target => {
            const field = typingIn('text')
            tap(screen.getByTestId(target))
            expect(document.activeElement).toBe(field)
        }
    )

    test('a scroll keeps the keyboard up', () => {
        const field = typingIn('text')
        const blank = screen.getByTestId('blank')
        send(blank, 'pointerdown', {})
        send(blank, 'pointercancel', {})
        send(blank, 'pointerup', {})
        expect(document.activeElement).toBe(field)
    })

    test('a drag where scrolling is off keeps the keyboard up', () => {
        const field = typingIn('text')
        const blank = screen.getByTestId('blank')
        send(blank, 'pointerdown', { clientY: 100 })
        send(blank, 'pointerup', { clientY: 140 })
        expect(document.activeElement).toBe(field)
    })

    test('a small drift still counts as a tap', () => {
        const field = typingIn('text')
        const blank = screen.getByTestId('blank')
        send(blank, 'pointerdown', { clientY: 100 })
        send(blank, 'pointerup', { clientY: 106 })
        expect(document.activeElement).not.toBe(field)
    })

    test('a mouse is left to the browser', () => {
        const field = typingIn('text')
        tap(screen.getByTestId('blank'), { pointerType: 'mouse' })
        expect(document.activeElement).toBe(field)
    })

    test('a second finger lifting does not count', () => {
        const field = typingIn('text')
        const blank = screen.getByTestId('blank')
        send(blank, 'pointerdown', { pointerId: 1 })
        send(blank, 'pointerup', { pointerId: 2 })
        expect(document.activeElement).toBe(field)
    })

    describe('the mousedown after a tap', () => {
        const mouseDown = (target: Element) => {
            const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
            target.dispatchEvent(event)
            return event.defaultPrevented
        }

        test('is cancelled outside a field, with the keyboard up or not', () => {
            const blank = screen.getByTestId('blank')
            typingIn('text')
            tap(blank)
            expect(mouseDown(blank)).toBe(true)
            tap(blank)
            expect(mouseDown(blank)).toBe(true)
        })

        test('still reaches its click', () => {
            const button = screen.getByTestId('button')
            const onClick = jest.fn()
            button.addEventListener('click', onClick)
            tap(button)
            mouseDown(button)
            button.click()
            expect(onClick).toHaveBeenCalledTimes(1)
        })

        test.each(['text', 'editor', 'completion', 'label'])('is left alone on %s', target => {
            const element = screen.getByTestId(target)
            tap(element)
            expect(mouseDown(element)).toBe(false)
        })

        test('is left alone after a drag', () => {
            const blank = screen.getByTestId('blank')
            send(blank, 'pointerdown', { clientY: 100 })
            send(blank, 'pointerup', { clientY: 140 })
            expect(mouseDown(blank)).toBe(false)
        })

        test('only the first one is cancelled', () => {
            const blank = screen.getByTestId('blank')
            tap(blank)
            mouseDown(blank)
            expect(mouseDown(blank)).toBe(false)
        })

        test('a real mouse press after a tap with no mousedown is left alone', () => {
            const blank = screen.getByTestId('blank')
            tap(blank)
            send(blank, 'pointerdown', { pointerType: 'mouse' })
            expect(mouseDown(blank)).toBe(false)
        })
    })

    test('a focused button is left alone', () => {
        const button = typingIn('button')
        tap(screen.getByTestId('blank'))
        expect(document.activeElement).toBe(button)
    })
})

test('stops listening when the page goes away', () => {
    const { unmount } = render(<Page />)
    const field = typingIn('text')
    const blank = screen.getByTestId('blank')
    unmount()
    document.body.appendChild(field)
    field.focus()
    tap(blank)
    expect(document.activeElement).toBe(field)
    field.remove()
})
