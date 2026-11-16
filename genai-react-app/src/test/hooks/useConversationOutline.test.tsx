import { act, renderHook } from '@testing-library/react'
import { useConversationOutline } from '../../hooks/useConversationOutline'

const mockConversation = jest.fn()
const mockUI = jest.fn()
jest.mock('../../context/ConversationContext', () => ({
    useConversation: () => mockConversation(),
    useConversationUI: () => mockUI(),
}))
jest.mock('../../hooks/useVendorDisplayNames', () => ({
    useVendorDisplayNames: () => (id: string) => ({ OPENAI: 'OpenAI', CLAUDE: 'Anthropic' } as Record<string, string>)[id] ?? id,
}))

const block = (id: string, overrides: Record<string, unknown> = {}) => ({
    conversationBlockId: id,
    prompt: `Prompt ${id}`,
    responseMessages: [],
    isLoading: false,
    status: 'resolved',
    ...overrides,
})

const msg = (vendor: string) => ({ messageId: `${vendor}-m`, text: 'x', aiVendor: vendor })

describe('useConversationOutline', () => {
    beforeEach(() => mockUI.mockReturnValue({ activeViewportItem: null }))

    test('numbers the sent turns and leaves out the empty editor block', () => {
        const today = new Date()
        today.setHours(10, 34, 0, 0)
        mockConversation.mockReturnValue({
            conversationBlockList: [
                block('b1', { responseMessages: [msg('CLAUDE')], sentAt: today.getTime() }),
                block('b2', { responseMessages: [msg('CLAUDE'), msg('OPENAI')] }),
                block('b3', { status: 'draft', prompt: '' }),
            ],
        })
        const { result } = renderHook(() => useConversationOutline())

        expect(result.current.items.map(i => [i.id, i.number, i.prompt])).toEqual([
            ['b1', 1, 'Prompt b1'],
            ['b2', 2, 'Prompt b2'],
        ])
        expect(result.current.items[0].meta).toMatch(/^1 response · Anthropic · \d{2}:34/)
        expect(result.current.items[1].meta).toBe('2 responses · Anthropic, OpenAI')
        expect(result.current.currentId).toBe('b2')
    })

    test('a streaming turn shows its vendors with the generating flag', () => {
        mockConversation.mockReturnValue({
            conversationBlockList: [block('b1', { status: 'draft', isLoading: true, responseMessages: [msg('OPENAI')] })],
        })
        const { result } = renderHook(() => useConversationOutline())
        expect(result.current.items[0]).toMatchObject({ isGenerating: true, meta: 'OpenAI' })
    })

    test('an older turn shows its date as well as the time', () => {
        mockConversation.mockReturnValue({
            conversationBlockList: [block('b1', { responseMessages: [msg('OPENAI')], sentAt: Date.UTC(2026, 8, 19, 13, 58) })],
        })
        const { result } = renderHook(() => useConversationOutline())
        expect(result.current.items[0].meta).toMatch(/2026/)
    })

    test('the turn in view is the current one when it is a turn', () => {
        mockConversation.mockReturnValue({ conversationBlockList: [block('b1'), block('b2')] })
        mockUI.mockReturnValue({ activeViewportItem: { blockId: 'b1', type: 'response' } })
        expect(renderHook(() => useConversationOutline()).result.current.currentId).toBe('b1')

        mockUI.mockReturnValue({ activeViewportItem: { blockId: 'draft', type: 'request' } })
        expect(renderHook(() => useConversationOutline()).result.current.currentId).toBe('b2')
    })

    test('a new chat has no turns and no current turn', () => {
        mockConversation.mockReturnValue({ conversationBlockList: [block('conv-default', { status: 'draft', prompt: '' })] })
        const { result } = renderHook(() => useConversationOutline())
        expect(result.current.items).toEqual([])
        expect(result.current.currentId).toBeNull()
    })

    test('scrollToTurn brings the turn\'s block into view', () => {
        mockConversation.mockReturnValue({ conversationBlockList: [block('b1')] })
        const target = document.createElement('div')
        target.className = 'conversation-block-item'
        target.setAttribute('data-block-id', 'b1')
        target.scrollIntoView = jest.fn()
        document.body.appendChild(target)

        const { result } = renderHook(() => useConversationOutline())
        act(() => result.current.scrollToTurn('b1'))
        expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })

        act(() => result.current.scrollToTurn('missing'))
        target.remove()
    })
})
