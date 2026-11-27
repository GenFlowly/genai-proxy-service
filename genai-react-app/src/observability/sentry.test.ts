import * as Sentry from '@sentry/react'
import { setErrorBoundaryReporter } from '@genflowly/component-library'
import { config } from '../config/env'
import { reportRenderError, scrubBreadcrumb, startSentry, timeReply } from './sentry'

jest.mock('@sentry/react', () => ({
    init: jest.fn(),
    reactRouterBrowserTracingIntegration: jest.fn(),
    httpClientIntegration: jest.fn(),
    captureReactException: jest.fn(),
    startSpan: jest.fn(),
    startInactiveSpan: jest.fn(),
}))

jest.mock('@genflowly/component-library', () => ({
    setErrorBoundaryReporter: jest.fn(),
}))

const mockSentry = Sentry as jest.Mocked<typeof Sentry>
const replySpan = { name: 'reply span' }
const firstTokenSpan = { end: jest.fn() }

describe('sentry', () => {
    const { dsn, release } = config.sentry

    beforeEach(() => {
        jest.clearAllMocks()
        mockSentry.startSpan.mockImplementation((_options, callback) => callback(replySpan as any))
        mockSentry.startInactiveSpan.mockReturnValue(firstTokenSpan as any)
    })

    afterEach(() => {
        config.sentry.dsn = dsn
        config.sentry.release = release
    })

    describe('startSentry', () => {
        test('does nothing without a DSN', () => {
            config.sentry.dsn = ''
            startSentry()
            expect(mockSentry.init).not.toHaveBeenCalled()
            expect(setErrorBoundaryReporter).not.toHaveBeenCalled()
        })

        test('starts with the DSN and release, and collects no personal data', () => {
            config.sentry.dsn = 'https://key@o1.ingest.us.sentry.io/2'
            config.sentry.release = 'abc123'
            startSentry()
            expect(mockSentry.init).toHaveBeenCalledWith(expect.objectContaining({
                dsn: 'https://key@o1.ingest.us.sentry.io/2',
                release: 'abc123',
                tracesSampleRate: 1,
                dataCollection: {
                    userInfo: false,
                    cookies: false,
                    httpHeaders: false,
                    httpBodies: [],
                    urlQueryParams: false,
                },
                beforeBreadcrumb: scrubBreadcrumb,
            }))
            expect(setErrorBoundaryReporter).toHaveBeenCalledWith(reportRenderError)
        })

        test('leaves the release unset when the build has none', () => {
            config.sentry.dsn = 'https://key@o1.ingest.us.sentry.io/2'
            config.sentry.release = ''
            startSentry()
            expect(mockSentry.init).toHaveBeenCalledWith(expect.objectContaining({ release: undefined }))
        })
    })

    describe('scrubBreadcrumb', () => {
        test('drops console.log breadcrumbs', () => {
            expect(scrubBreadcrumb({ category: 'console', level: 'log', message: 'response text' })).toBeNull()
        })

        test('keeps console warnings and errors', () => {
            const warning = { category: 'console', level: 'warning' as const, message: 'retrying' }
            const error = { category: 'console', level: 'error' as const, message: 'stream failed' }
            expect(scrubBreadcrumb(warning)).toEqual(warning)
            expect(scrubBreadcrumb(error)).toEqual(error)
        })

        test('strips query strings from request and navigation URLs', () => {
            expect(scrubBreadcrumb({
                category: 'fetch',
                data: { method: 'GET', url: 'https://api.genflowly.com/api/search?q=private%20words', status_code: 200 },
            })).toEqual({
                category: 'fetch',
                data: { method: 'GET', url: 'https://api.genflowly.com/api/search', status_code: 200 },
            })
            expect(scrubBreadcrumb({
                category: 'navigation',
                data: { from: '/history?q=a', to: '/chat/c1' },
            })).toEqual({ category: 'navigation', data: { from: '/history', to: '/chat/c1' } })
        })

        test('passes breadcrumbs without data through', () => {
            const click = { category: 'ui.click', message: 'button.send' }
            expect(scrubBreadcrumb(click)).toBe(click)
        })
    })

    test('reportRenderError sends the error with its component stack', () => {
        const error = new Error('render failed')
        const info = { componentStack: '\n    at Response' }
        reportRenderError(error, info)
        expect(mockSentry.captureReactException).toHaveBeenCalledWith(error, info)
    })

    describe('timeReply', () => {
        const aiConfig = { aiVendor: 'OPENAI', model: 'gpt-5.4-nano' }

        test('runs inside a reply span tagged with the vendor and model', async () => {
            await expect(timeReply(aiConfig, async () => 'done')).resolves.toBe('done')
            expect(mockSentry.startSpan).toHaveBeenCalledWith(
                {
                    name: 'reply',
                    op: 'ai.reply',
                    forceTransaction: true,
                    attributes: { 'ai.vendor': 'OPENAI', 'ai.model': 'gpt-5.4-nano' },
                },
                expect.any(Function)
            )
            expect(mockSentry.startInactiveSpan).not.toHaveBeenCalled()
        })

        test('records the first token once, timed from the start of the reply', async () => {
            jest.spyOn(Date, 'now').mockReturnValue(1_000)
            await timeReply(aiConfig, async (timing) => {
                timing.firstToken()
                timing.firstToken()
            })
            expect(mockSentry.startInactiveSpan).toHaveBeenCalledTimes(1)
            expect(mockSentry.startInactiveSpan).toHaveBeenCalledWith({
                name: 'first token',
                op: 'ai.reply.first_token',
                parentSpan: replySpan,
                startTime: 1_000,
            })
            expect(firstTokenSpan.end).toHaveBeenCalledTimes(1)
            jest.restoreAllMocks()
        })

        test('passes a failure through', async () => {
            const failure = new Error('stream failed')
            await expect(timeReply(aiConfig, async () => { throw failure })).rejects.toBe(failure)
        })
    })
})
