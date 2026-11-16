import { useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useAI } from '../context/AIContext'

/** The latest version of the instruction loaded into the conversation, or null. */
export function useLoadedInstruction() {
    const { customerInstructions } = useAuth()
    const { selectedInstructionId } = useAI()

    return useMemo(() => {
        if (!selectedInstructionId) return null
        const versions = (customerInstructions ?? []).filter(i => i.id === selectedInstructionId)
        return versions.sort((a, b) => b.version - a.version)[0] ?? null
    }, [selectedInstructionId, customerInstructions])
}
