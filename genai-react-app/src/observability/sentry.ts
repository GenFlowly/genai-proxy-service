import * as Sentry from '@sentry/react'
import type { Breadcrumb } from '@sentry/react'
import type { ErrorInfo } from 'react'
import { setErrorBoundaryReporter } from '@genflowly/component-library'
import { createRoutesFromChildren, matchRoutes, useLocation, useNavigationType } from 'react-router'
import { config } from '../config/env'

/** Times one streamed reply, from sending the request to the end of the stream. */
export interface ReplyTiming {
    /** Marks the reply's first text; later calls are ignored. */
    firstToken(): void
}

/**
 * Crash, error and performance reporting. Off when no DSN is configured, which
 * is every build but production. The privacy policy describes what is sent, so
 * a change to what this collects needs a matching policy change.
 */
export function startSentry(): void {
    const { dsn, release } = config.sentry
    if (!dsn) return
    Sentry.init({
        dsn,
        environment: process.env.NODE_ENV,
        release: release || undefined,
        integrations: [
            Sentry.reactRouterBrowserTracingIntegration({ useLocation, useNavigationType, createRoutesFromChildren, matchRoutes }),
            Sentry.httpClientIntegration(),
        ],
        tracesSampleRate: 1,
        // Request bodies hold prompts; query strings hold search terms and signed S3 links.
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
        },
        beforeBreadcrumb: scrubBreadcrumb,
    })
    // Covers the library's own boundaries too, such as the one around each reply.
    setErrorBoundaryReporter(reportRenderError)
}

/** Sends a render error an ErrorBoundary caught, with its component stack. */
export function reportRenderError(error: Error, info: ErrorInfo): void {
    Sentry.captureReactException(error, info)
}

const URL_KEYS = ['url', 'from', 'to']

/**
 * Drops console.log/info/debug breadcrumbs, which can print reply text (warnings
 * and errors print error objects and ids), and strips query strings from URLs.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
    if (breadcrumb.category === 'console' && breadcrumb.level !== 'warning' && breadcrumb.level !== 'error') {
        return null
    }
    if (!breadcrumb.data) return breadcrumb
    const data = { ...breadcrumb.data }
    for (const key of URL_KEYS) {
        if (typeof data[key] === 'string') data[key] = data[key].split('?')[0]
    }
    return { ...breadcrumb, data }
}

/**
 * Runs [run] inside an `ai.reply` span tagged with the vendor and model, and
 * records the time to the first text as an `ai.reply.first_token` child span.
 * A reply that fails or is stopped ends with an error status.
 */
export function timeReply<T>(
    aiConfig: { aiVendor: string; model: string },
    run: (timing: ReplyTiming) => Promise<T>
): Promise<T> {
    const startTime = Date.now()
    return Sentry.startSpan(
        {
            name: 'reply',
            op: 'ai.reply',
            // A reply outlives the page-load span it may start under.
            forceTransaction: true,
            attributes: { 'ai.vendor': aiConfig.aiVendor, 'ai.model': aiConfig.model },
        },
        (reply) => {
            let firstTokenSeen = false
            return run({
                firstToken() {
                    if (firstTokenSeen) return
                    firstTokenSeen = true
                    Sentry.startInactiveSpan({
                        name: 'first token',
                        op: 'ai.reply.first_token',
                        parentSpan: reply,
                        startTime,
                    }).end()
                },
            })
        }
    )
}
