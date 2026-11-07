import { config } from '../../config/env'
import { SupportRequest, SupportRequestError, isSupportTopic, sendSupportRequest } from '../../services/supportService'

const REQUEST: SupportRequest = {
    name: 'Jane',
    email: 'jane@example.com',
    topic: 'bug',
    message: 'The send button does nothing.',
    website: '',
    context: { source: 'web', page: 'https://genflowly.com/support' },
}

describe('supportService', () => {
    const originalFetch = global.fetch
    const originalUrl = config.support.requestUrl

    beforeEach(() => {
        config.support.requestUrl = 'https://support.example/support'
        global.fetch = jest.fn()
    })

    afterEach(() => {
        global.fetch = originalFetch
        config.support.requestUrl = originalUrl
    })

    const respond = (status: number, body: unknown) =>
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: status >= 200 && status < 300,
            status,
            json: async () => {
                if (body instanceof Error) throw body
                return body
            },
        })

    test('posts the request as JSON once and returns its ID', async () => {
        respond(202, { requestId: 'req-1' })

        await expect(sendSupportRequest(REQUEST)).resolves.toBe('req-1')

        expect(global.fetch).toHaveBeenCalledTimes(1)
        expect(global.fetch).toHaveBeenCalledWith('https://support.example/support', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(REQUEST),
        })
    })

    test('an accepted request without an ID still resolves', async () => {
        respond(202, null)
        await expect(sendSupportRequest(REQUEST)).resolves.toBe('')
    })

    test('a build without the API URL fails without a request', async () => {
        config.support.requestUrl = ''

        await expect(sendSupportRequest(REQUEST)).rejects.toMatchObject({ name: 'SupportRequestError', status: 0 })
        expect(global.fetch).not.toHaveBeenCalled()
    })

    test('a refused request carries the fields the API named', async () => {
        respond(400, { error: 'invalid_request', fields: ['email', 7, 'message'] })

        const error = await sendSupportRequest(REQUEST).catch(e => e)

        expect(error).toBeInstanceOf(SupportRequestError)
        expect(error.status).toBe(400)
        expect(error.fields).toEqual(['email', 'message'])
    })

    test('an error without a JSON body has no fields', async () => {
        respond(502, new SyntaxError('Unexpected token'))

        const error = await sendSupportRequest(REQUEST).catch(e => e)

        expect(error.status).toBe(502)
        expect(error.fields).toEqual([])
    })

    test('a network failure is passed on', async () => {
        (global.fetch as jest.Mock).mockRejectedValue(new TypeError('Failed to fetch'))
        await expect(sendSupportRequest(REQUEST)).rejects.toThrow('Failed to fetch')
    })

    test('knows its topics', () => {
        expect(isSupportTopic('privacy')).toBe(true)
        expect(isSupportTopic('refund')).toBe(false)
        expect(isSupportTopic(null)).toBe(false)
    })
})
