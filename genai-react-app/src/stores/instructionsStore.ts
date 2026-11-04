import { InstructionResponse } from '../models/instruction.models'
import { customerKey, StorageSuffix } from '../utils/storageKeys'

/**
 * Module-level store for the customer's instruction list (may hold multiple
 * versions of the same instruction id). Lives outside React state so
 * MUTATION SERVICES write it on success (instructionService create/delete),
 * making every surface — including ones that never knew about the list, like
 * the agent editor's "Convert to instruction" — update it without ad-hoc
 * mirroring at call sites.
 *
 * Persisted per customer at `${customerId}_instructions` for the
 * stale-while-revalidate paint on the next session.
 */

const EMPTY: InstructionResponse[] = []

let activeCustomerId: string | null = null
let instructions: InstructionResponse[] = EMPTY
let hasAllVersions = false
const listeners = new Set<() => void>()

function emit(): void {
    listeners.forEach(listener => listener())
}

function persist(): void {
    if (!activeCustomerId) return
    try {
        localStorage.setItem(
            customerKey(activeCustomerId, StorageSuffix.instructions),
            JSON.stringify(instructions)
        )
    } catch {
        // Best-effort — next session refills from /onboard
    }
}

export function subscribeInstructions(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function getInstructions(): InstructionResponse[] {
    return instructions
}

/** Switch the active customer and paint their cached copy (null = logout). */
export function setInstructionsCustomer(customerId: string | null): void {
    if (customerId === activeCustomerId) return
    activeCustomerId = customerId
    instructions = EMPTY
    hasAllVersions = false
    if (customerId) {
        try {
            const raw = localStorage.getItem(customerKey(customerId, StorageSuffix.instructions))
            if (raw) {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed)) instructions = parsed
            }
        } catch {
            // Corrupt cache — start empty; /onboard refills
        }
    }
    emit()
}

function write(customerId: string | null, next: InstructionResponse[]): void {
    if (customerId) activeCustomerId = customerId
    instructions = next
    persist()
    emit()
}

/** Full replace from an explicit, signed-in list refetch, which holds every version. */
export function replaceInstructions(customerId: string | null, next: InstructionResponse[]): void {
    hasAllVersions = true
    write(customerId, next)
}

/**
 * The list from /onboard, or one fetched with no session. /onboard holds only
 * each instruction's newest version and can land before or after the refetch,
 * so once the refetch has landed this mustn't overwrite it.
 */
export function seedInstructions(customerId: string | null, next: InstructionResponse[]): void {
    if (customerId && customerId !== activeCustomerId) hasAllVersions = false
    if (hasAllVersions) return
    write(customerId, next)
}

/**
 * Upsert one instruction version — the write-through for create/new-version
 * saves. An existing (id, version) entry is replaced; a new version prepends.
 */
export function upsertInstruction(instruction: InstructionResponse): void {
    const index = instructions.findIndex(
        item => item.id === instruction.id && item.version === instruction.version
    )
    if (index !== -1) {
        const next = [...instructions]
        next[index] = instruction
        instructions = next
    } else {
        instructions = [instruction, ...instructions]
    }
    persist()
    emit()
}

/** Drop every version of a deleted instruction. */
export function removeInstruction(instructionId: string): void {
    const next = instructions.filter(item => item.id !== instructionId)
    if (next.length === instructions.length) return
    instructions = next
    persist()
    emit()
}
