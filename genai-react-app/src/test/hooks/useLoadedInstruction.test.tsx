import { renderHook } from '@testing-library/react'
import { useLoadedInstruction } from '../../hooks/useLoadedInstruction'

const mockAuth = jest.fn()
const mockAI = jest.fn()
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth() }))
jest.mock('../../context/AIContext', () => ({ useAI: () => mockAI() }))

describe('useLoadedInstruction', () => {
    test('picks the latest version of the selected instruction', () => {
        mockAuth.mockReturnValue({
            customerInstructions: [
                { id: 'I1', version: 1, name: 'Old' },
                { id: 'I1', version: 3, name: 'Newest' },
                { id: 'I1', version: 2, name: 'Middle' },
                { id: 'I2', version: 9, name: 'Other' },
            ],
        })
        mockAI.mockReturnValue({ selectedInstructionId: 'I1' })
        const { result } = renderHook(() => useLoadedInstruction())
        expect(result.current?.name).toBe('Newest')
    })

    test('null without a selection or when the instruction is gone', () => {
        mockAuth.mockReturnValue({ customerInstructions: undefined })
        mockAI.mockReturnValue({ selectedInstructionId: null })
        expect(renderHook(() => useLoadedInstruction()).result.current).toBeNull()

        mockAI.mockReturnValue({ selectedInstructionId: 'missing' })
        expect(renderHook(() => useLoadedInstruction()).result.current).toBeNull()
    })
})
