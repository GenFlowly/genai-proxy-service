import { InstructionResponse } from '../../../models/instruction.models'
import { createCustomerCache } from '../../../utils/customerListCache'
import { StorageSuffix } from '../../../utils/storageKeys'

const store = createCustomerCache<InstructionResponse[]>(StorageSuffix.recentInstructions, parsed =>
    Array.isArray(parsed) ? (parsed as InstructionResponse[]) : null
)

export function loadRecentInstructionsCache(customerId: string | null): InstructionResponse[] | null {
    return store.load(customerId)
}

export function saveRecentInstructionsCache(customerId: string | null, instructions: InstructionResponse[]): void {
    store.save(customerId, instructions)
}

/** Logout hook / test helper: forget everything, for every customer. */
export function clearRecentInstructionsCache(): void {
    store.clear()
}
