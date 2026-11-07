export interface DiffPart {
    text: string
    kind: 'same' | 'ins' | 'del'
}

// Past this many token pairs the word-level table is too big to build on
// every render; the diff falls back to one changed block between the common
// start and end.
const MAX_CELLS = 400_000

function tokens(text: string): string[] {
    return text.split(/(\s+|[.,;:!?()[\]"“”'‘’])/).filter(token => token.length > 0)
}

function push(parts: DiffPart[], text: string, kind: DiffPart['kind']) {
    if (!text) return
    const last = parts[parts.length - 1]
    if (last && last.kind === kind) last.text += text
    else parts.push({ text, kind })
}

function edgeDiff(before: string, after: string): DiffPart[] {
    let start = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    let end = 0
    while (
        end < before.length - start &&
        end < after.length - start &&
        before[before.length - 1 - end] === after[after.length - 1 - end]
    ) end++
    const parts: DiffPart[] = []
    push(parts, before.slice(0, start), 'same')
    push(parts, before.slice(start, before.length - end), 'del')
    push(parts, after.slice(start, after.length - end), 'ins')
    push(parts, before.slice(before.length - end), 'same')
    return parts
}

/** The words removed from [before] and added in [after], in reading order. */
export function wordDiff(before: string, after: string): DiffPart[] {
    const a = tokens(before)
    const b = tokens(after)
    if (a.length * b.length > MAX_CELLS) return edgeDiff(before, after)

    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
        }
    }
    const parts: DiffPart[] = []
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push(parts, a[i], 'same')
            i++
            j++
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            push(parts, a[i++], 'del')
        } else {
            push(parts, b[j++], 'ins')
        }
    }
    while (i < a.length) push(parts, a[i++], 'del')
    while (j < b.length) push(parts, b[j++], 'ins')
    return trimChanges(parts)
}

/** Moves the spaces at either end of a change out of it, so only words are highlighted. */
function trimChanges(parts: DiffPart[]): DiffPart[] {
    const out: DiffPart[] = []
    for (const part of parts) {
        if (part.kind === 'same') {
            push(out, part.text, 'same')
            continue
        }
        const [, lead, body, tail] = part.text.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? ['', '', part.text, '']
        push(out, lead, 'same')
        push(out, body, part.kind)
        push(out, tail, 'same')
    }
    return out
}
