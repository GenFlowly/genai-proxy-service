import { wordDiff } from '../../utils/wordDiff'

const show = (before: string, after: string) =>
    wordDiff(before, after).map(part => (part.kind === 'same' ? part.text : `${part.kind === 'ins' ? '+' : '-'}[${part.text}]`)).join('')

describe('wordDiff', () => {
    test('marks the words added and removed, with punctuation kept apart', () => {
        expect(show('Prefers concise answers.', 'Prefers concise answers with the conclusion first.'))
            .toBe('Prefers concise answers +[with the conclusion first].')
        expect(show('Prefers short answers.', 'Prefers concise answers.')).toBe('Prefers -[short]+[concise] answers.')
    })

    test('keeps spaces out of the highlighted words', () => {
        const parts = wordDiff('a c', 'a b c')
        expect(parts.find(part => part.kind === 'ins')!.text).toBe('b')
    })

    test('identical, empty and wholly new text', () => {
        expect(wordDiff('same', 'same')).toEqual([{ text: 'same', kind: 'same' }])
        expect(wordDiff('', 'new text')).toEqual([{ text: 'new text', kind: 'ins' }])
        expect(wordDiff('old text', '')).toEqual([{ text: 'old text', kind: 'del' }])
    })

    test('very long text falls back to one changed block between the common start and end', () => {
        const start = 'word '.repeat(700)
        const end = ' tail'.repeat(10)
        expect(wordDiff(`${start}old${end}`, `${start}new${end}`)).toEqual([
            { text: start, kind: 'same' },
            { text: 'old', kind: 'del' },
            { text: 'new', kind: 'ins' },
            { text: end, kind: 'same' },
        ])
    })
})
