import { endpoints } from '../../config/endpoints'
import {
    ModerationError,
    blockUser,
    getBlockedUsers,
    getSharedItemOwner,
    moderationErrorFrom,
    reportContent,
    unblockUser,
} from '../../services/moderationService'

describe('moderationService', () => {
    const originalFetch = global.fetch

    beforeEach(() => {
        global.fetch = jest.fn()
    })

    afterEach(() => {
        global.fetch = originalFetch
    })

    const respond = (status: number, body: unknown = {}) =>
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: status >= 200 && status < 300,
            status,
            statusText: 'status',
            json: async () => body,
        })

    test('getSharedItemOwner asks for the item as the signed-in user', async () => {
        respond(200, { ownerCustomerId: 'CU1', canBlock: true, canRemove: true, alreadyReported: false })
        const owner = await getSharedItemOwner('token', 'CONVERSATION', 'conv/1')
        expect(owner.ownerCustomerId).toBe('CU1')
        const [url, options] = (global.fetch as jest.Mock).mock.calls[0]
        expect(url).toBe(`${endpoints.sharedItemOwner}?entityType=CONVERSATION&entityId=conv%2F1`)
        expect(options.headers.Authorization).toBe('Bearer token')
    })

    test('reportContent posts the report', async () => {
        respond(200, { created: true })
        await reportContent('token', { entityType: 'INSTRUCTION', entityId: 'INS-1', reason: 'SPAM', details: 'x' })
        const [url, options] = (global.fetch as jest.Mock).mock.calls[0]
        expect(url).toBe(endpoints.reports)
        expect(options.method).toBe('POST')
        expect(JSON.parse(options.body)).toEqual({ entityType: 'INSTRUCTION', entityId: 'INS-1', reason: 'SPAM', details: 'x' })
    })

    test('blocked users, block and unblock call their endpoints', async () => {
        respond(200, [{ customerId: 'CU2', blockedAt: 'now' }])
        await expect(getBlockedUsers('token')).resolves.toEqual([{ customerId: 'CU2', blockedAt: 'now' }])
        await blockUser('token', 'CU2')
        expect((global.fetch as jest.Mock).mock.calls[1][1].body).toBe(JSON.stringify({ customerId: 'CU2' }))
        await unblockUser('token', 'CU/2')
        expect((global.fetch as jest.Mock).mock.calls[2][0]).toBe(`${endpoints.blocks}/CU%2F2`)
        expect((global.fetch as jest.Mock).mock.calls[2][1].method).toBe('DELETE')
    })

    test.each([
        ['getSharedItemOwner', () => getSharedItemOwner('t', 'CONVERSATION', 'c')],
        ['reportContent', () => reportContent('t', { entityType: 'CONVERSATION', entityId: 'c', reason: 'SPAM' })],
        ['getBlockedUsers', () => getBlockedUsers('t')],
        ['blockUser', () => blockUser('t', 'c')],
        ['unblockUser', () => unblockUser('t', 'c')],
    ])('%s throws on a failed response', async (_name, call) => {
        respond(403)
        await expect(call()).rejects.toThrow()
    })

    test('moderationErrorFrom recognises the two refusals', async () => {
        const refused = (code: string) => ({ status: 422, statusText: '', json: async () => ({ error: 'No', code }) }) as unknown as Response
        const blocked = await moderationErrorFrom(refused('CONTENT_BLOCKED'), 'Share failed')
        expect(blocked).toBeInstanceOf(ModerationError)
        expect((blocked as ModerationError).code).toBe('CONTENT_BLOCKED')
        expect(((await moderationErrorFrom(refused('BLOCKED'), 'Share failed')) as ModerationError).code).toBe('BLOCKED')
    })

    test('moderationErrorFrom keeps other failures ordinary, with or without a JSON body', async () => {
        const other = await moderationErrorFrom({ status: 500, statusText: 'Oops', json: async () => ({ error: 'x' }) } as unknown as Response, 'Share failed')
        expect(other).not.toBeInstanceOf(ModerationError)
        expect(other.message).toBe('Share failed: 500 Oops')
        const noBody = await moderationErrorFrom({ status: 502, statusText: 'Bad', json: async () => { throw new Error('html') } } as unknown as Response, 'Share failed')
        expect(noBody.message).toBe('Share failed: 502 Bad')
    })
})
