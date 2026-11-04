import { useEffect } from 'react'

// How far a finger can drift and still be a tap. iOS reports a scroll as
// pointercancel, but areas with touch-action: none report it as a pointerup.
const TAP_SLOP_PX = 10

const NON_TYPING_INPUT_TYPES = new Set([
    'button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit',
])

// A tap here focuses a field or belongs to one. .cm-tooltip is the composer's
// completion popup, which lives under <body>, outside the editor.
const KEEPS_KEYBOARD_SELECTOR = 'input, textarea, select, label, [contenteditable="true"], .cm-editor, .cm-tooltip'

function isTypingField(element: Element | null): element is HTMLElement {
    if (element instanceof HTMLInputElement) return !NON_TYPING_INPUT_TYPES.has(element.type)
    return element instanceof HTMLElement && element.matches('textarea, [contenteditable="true"]')
}

/**
 * On a phone, a tap outside the field being typed in closes the keyboard, and
 * the tap still reaches what's under it. iOS Safari otherwise keeps the keyboard
 * up until its Done button is pressed.
 *
 * Pointer events, because iOS Safari sends no click for a tap on anything that
 * isn't interactive. It blurs on pointerup, before the click, so a button that
 * focuses a field of its own keeps that focus.
 *
 * The mousedown a tap sends afterwards is cancelled: its default puts the caret
 * in the nearest text, which opens the keyboard again when that's the composer.
 * The click still fires.
 */
export function useTapOutsideEndsEditing(): void {
    useEffect(() => {
        let touch: { id: number; x: number; y: number } | null = null
        let cancelNextMouseDown = false

        const handleDown = (e: PointerEvent) => {
            cancelNextMouseDown = false
            touch = e.pointerType === 'touch' ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null
        }
        const handleCancel = () => {
            touch = null
        }
        const handleUp = (e: PointerEvent) => {
            if (!touch || e.pointerId !== touch.id) return
            const moved = Math.hypot(e.clientX - touch.x, e.clientY - touch.y)
            touch = null
            if (moved > TAP_SLOP_PX) return
            if (e.target instanceof Element && e.target.closest(KEEPS_KEYBOARD_SELECTOR)) return
            cancelNextMouseDown = true
            const focused = document.activeElement
            if (isTypingField(focused)) focused.blur()
        }
        const handleMouseDown = (e: MouseEvent) => {
            if (!cancelNextMouseDown) return
            cancelNextMouseDown = false
            e.preventDefault()
        }

        document.addEventListener('pointerdown', handleDown, true)
        document.addEventListener('pointerup', handleUp, true)
        document.addEventListener('pointercancel', handleCancel, true)
        document.addEventListener('mousedown', handleMouseDown, true)
        return () => {
            document.removeEventListener('pointerdown', handleDown, true)
            document.removeEventListener('pointerup', handleUp, true)
            document.removeEventListener('pointercancel', handleCancel, true)
            document.removeEventListener('mousedown', handleMouseDown, true)
        }
    }, [])
}
