import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import InstructionChip from '../../../../../components/widgets/CenterWidgets/ConversationListWidget/InstructionChip'

const mockInstruction = jest.fn()
jest.mock('../../../../../hooks/useLoadedInstruction', () => ({
    useLoadedInstruction: () => mockInstruction(),
}))

describe('InstructionChip', () => {
    test('shows the loaded instruction\'s icon and name and opens the picker', () => {
        mockInstruction.mockReturnValue({ id: 'I1', name: 'General Purpose Assistant', icon: '🔍📋', version: 2 })
        const onClick = jest.fn()
        render(<InstructionChip onClick={onClick} />)

        const chip = screen.getByRole('button', { name: 'Choose instruction' })
        expect(chip).toHaveTextContent('🔍📋General Purpose Assistant')
        fireEvent.click(chip)
        expect(onClick).toHaveBeenCalledTimes(1)
    })

    test('without an instruction it invites a choice, and tells on hover', () => {
        mockInstruction.mockReturnValue(null)
        render(<InstructionChip onClick={jest.fn()} />)

        const chip = screen.getByTestId('instruction-chip')
        expect(chip).toHaveTextContent('Choose instruction')
        fireEvent.mouseEnter(chip.parentElement!)
        expect(screen.getByRole('tooltip')).toHaveTextContent('Choose instruction')
    })
})
