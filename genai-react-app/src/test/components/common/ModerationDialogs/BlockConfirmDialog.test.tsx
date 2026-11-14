import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { BlockConfirmDialog } from '../../../../components/common/ModerationDialogs/BlockConfirmDialog'

describe('BlockConfirmDialog', () => {
    test('confirms and cancels', () => {
        const onConfirm = jest.fn()
        const onCancel = jest.fn()
        render(<BlockConfirmDialog isOpen name="@mara" blocking={false} error={null} onConfirm={onConfirm} onCancel={onCancel} />)
        expect(screen.getByText('Block @mara?')).toBeInTheDocument()
        fireEvent.click(screen.getByTestId('block-confirm-button'))
        expect(onConfirm).toHaveBeenCalled()
        fireEvent.click(screen.getByText('Cancel'))
        expect(onCancel).toHaveBeenCalled()
    })

    test('while blocking its buttons are disabled, and it shows failures', () => {
        render(<BlockConfirmDialog isOpen name="@mara" blocking error="failed" onConfirm={jest.fn()} onCancel={jest.fn()} />)
        expect(screen.getByTestId('block-confirm-button')).toBeDisabled()
        expect(screen.getByTestId('block-confirm-button')).toHaveTextContent('Blocking...')
        expect(screen.getByRole('alert')).toHaveTextContent('failed')
    })
})
