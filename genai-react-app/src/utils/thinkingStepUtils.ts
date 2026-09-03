import { ThinkingStep } from '../models/conversation.models'

/**
 * Fold one streamed "ks" event into the accumulated step list (immutably).
 *
 * Correlation rules (a node can run multiple times — graph cycles):
 * - `done`    → updates the LATEST entry with that node id that is still
 *               running; if none is running (e.g. we joined mid-stream), the
 *               event is appended as an already-done step.
 * - `running` → refreshes the latest entry with that node id if it is still
 *               running (label update); otherwise — first appearance, or a new
 *               cycle after the node finished — a NEW entry is appended.
 */
export function applyThinkingStep(steps: ThinkingStep[], incoming: ThinkingStep): ThinkingStep[] {
    const latestIdx = findLatestIndex(steps, incoming.node)
    const latestIsRunning = latestIdx !== -1 && steps[latestIdx].status === 'running'

    if (latestIsRunning) {
        const next = steps.slice()
        next[latestIdx] = { ...steps[latestIdx], ...incoming }
        return next
    }
    return [...steps, incoming]
}

function findLatestIndex(steps: ThinkingStep[], node: string): number {
    for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].node === node) return i
    }
    return -1
}
