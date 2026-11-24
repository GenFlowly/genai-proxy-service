import { plainPrompt } from '../../utils/plainPrompt'

describe('plainPrompt', () => {
    test('drops emphasis, code and strikethrough marks', () => {
        expect(plainPrompt('explain **quicksort** vs *merge sort* and `heapq` ~~now~~'))
            .toBe('explain quicksort vs merge sort and heapq now')
        expect(plainPrompt('__bold__ and _italic_')).toBe('bold and italic')
    })

    test('keeps marks inside words and lone ones', () => {
        expect(plainPrompt('rename my_var_name and compute 2*3*4')).toBe('rename my_var_name and compute 2*3*4')
        expect(plainPrompt('a * b')).toBe('a * b')
    })

    test('drops heading, quote, fence and link syntax, one line', () => {
        expect(plainPrompt('# Plan\n> quoted line\n\n```ts\nconst x = 1\n```\nsee [the docs](https://example.com)'))
            .toBe('Plan quoted line const x = 1 see the docs')
    })

    test('a plain prompt comes back as it was', () => {
        expect(plainPrompt('Add a day trip to Nara')).toBe('Add a day trip to Nara')
    })
})
