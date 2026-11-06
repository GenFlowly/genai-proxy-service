import { queryClient } from '../../queryClient'
import { MEMORIES_QUERY_KEY, MEMORY_DETAIL_QUERY_KEY } from '../../hooks/queries/queryKeys'
import {
    MemoryApiError,
    copyMemory,
    createMemory,
    deleteAllMemories,
    deleteMemory,
    editMemory,
    getMemories,
    getMemoryUsage,
    memoriesCache,
    moveMemory,
} from '../../services/memoriesService'
import { CustomerMemory } from '../../models/memory.models'

const mockFetch = jest.fn()
jest.mock('../../utils/apiUtils', () => ({ fetchWithRetry: (...args: unknown[]) => mockFetch(...args) }))

const memory = (id: string, overrides: Partial<CustomerMemory> = {}): CustomerMemory => ({
    memoryId: id, text: 'Fact.', kind: 'CORE', sourceType: 'USER', createdAt: 't', updatedAt: 't',
    placements: [{ projectId: null, kind: 'CORE' }], version: 1, tracked: true, hitCount: 0, ...overrides,
})

const respond = (status: number, body: unknown = {}) =>
    mockFetch.mockResolvedValueOnce({ ok: status < 300, status, statusText: `HTTP ${status}`, json: async () => body })

function seed(list: CustomerMemory[]) {
    queryClient.setQueryData([MEMORIES_QUERY_KEY, 'CU1'], list)
    memoriesCache.save('CU1', list)
}

beforeEach(() => {
    queryClient.clear()
    memoriesCache.clear()
    localStorage.clear()
    localStorage.setItem('customerId', 'CU1')
})

describe('memoriesService', () => {
    test('lists memories with bearer auth and tolerates a missing array', async () => {
        respond(200, { memories: [memory('MEM#a')] })
        expect(await getMemories('tok')).toHaveLength(1)
        expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')

        respond(200, {})
        expect(await getMemories('tok')).toEqual([])
    })

    test('a refusal carries its status and the server message', async () => {
        respond(409, { error: 'The memory changed while you were editing it' })

        const error = await editMemory('tok', 'MEM#a', 'x', 1).catch(e => e)

        expect(error).toBeInstanceOf(MemoryApiError)
        expect(error.status).toBe(409)
        expect(error.message).toBe('The memory changed while you were editing it')
    })

    test('a refusal without a JSON body keeps the status line', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new Error('html') } })

        await expect(getMemories('tok')).rejects.toMatchObject({ status: 502, message: '502 Bad Gateway' })
    })

    test('mutations write the list query, the stored copy and refresh the detail', async () => {
        seed([memory('MEM#a'), memory('MEM#b')])
        queryClient.setQueryData([MEMORY_DETAIL_QUERY_KEY, 'MEM#a'], { stale: true })
        const moved = memory('MEM#a', { placements: [{ projectId: 'PRJa', kind: 'EPISODIC' }], updatedAt: 'later' })
        respond(200, { memory: moved })

        await moveMemory('tok', 'MEM#a', null, 'PRJa', 'EPISODIC')

        const [url, init] = mockFetch.mock.calls[0]
        expect(url).toMatch(/\/memories\/MEM%23a\/move$/)
        expect(JSON.parse(init.body)).toEqual({ fromProjectId: null, toProjectId: 'PRJa', kind: 'EPISODIC' })
        expect(queryClient.getQueryData<CustomerMemory[]>([MEMORIES_QUERY_KEY, 'CU1'])![0]).toEqual(moved)
        expect(memoriesCache.load('CU1')![0]).toEqual(moved)
        expect(queryClient.getQueryState([MEMORY_DETAIL_QUERY_KEY, 'MEM#a'])?.isInvalidated).toBe(true)
    })

    test('create and copy add their result to the front of the list', async () => {
        seed([memory('MEM#a')])
        respond(200, { memory: memory('MEM#new') })
        await createMemory('tok', 'New fact.', 'EPISODIC', null)
        expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ text: 'New fact.', kind: 'EPISODIC', projectId: null })

        respond(200, { memory: memory('MEM#a', { placements: [{ projectId: 'PRJa', kind: 'CORE' }, { projectId: 'PRJb', kind: 'CORE' }] }) })
        await copyMemory('tok', 'MEM#a', 'PRJa', 'PRJb', 'CORE')

        expect(memoriesCache.load('CU1')!.map(m => m.memoryId)).toEqual(['MEM#a', 'MEM#new'])
    })

    test('deleting removes it, and a memory already gone counts as deleted', async () => {
        seed([memory('MEM#a'), memory('MEM#b')])
        respond(200, { status: 'success', deleted: true })
        expect(await deleteMemory('tok', 'MEM#a')).toBe(true)

        respond(404, { error: 'Memory not found' })
        expect(await deleteMemory('tok', 'MEM#b')).toBe(true)

        expect(memoriesCache.load('CU1')).toEqual([])
    })

    test('leaving one project keeps the memory with its other projects', async () => {
        seed([memory('MEM#a', { placements: [{ projectId: 'PRJa', kind: 'CORE' }, { projectId: 'PRJb', kind: 'CORE' }] })])
        respond(200, { status: 'success', deleted: false })

        expect(await deleteMemory('tok', 'MEM#a', 'PRJa')).toBe(false)

        expect(mockFetch.mock.calls[0][0]).toMatch(/\/memories\/MEM%23a\?projectId=PRJa$/)
        expect(memoriesCache.load('CU1')![0].placements).toEqual([{ projectId: 'PRJb', kind: 'CORE' }])
    })

    test('other delete failures surface', async () => {
        respond(500)
        await expect(deleteMemory('tok', 'MEM#a')).rejects.toMatchObject({ status: 500 })
    })

    test('deleting everything empties the list', async () => {
        seed([memory('MEM#a')])
        respond(200, { deleted: 1 })
        expect(await deleteAllMemories('tok')).toBe(1)
        expect(memoriesCache.load('CU1')).toEqual([])

        respond(200, {})
        expect(await deleteAllMemories('tok')).toBe(0)
    })

    test('usage pages pass the page size and the cursor', async () => {
        respond(200, { items: [], total: 0 })
        await getMemoryUsage('tok', 'MEM#a', 'abc', 10)

        expect(mockFetch.mock.calls[0][0]).toMatch(/\/memories\/MEM%23a\/usage\?limit=10&cursor=abc$/)
    })
})
