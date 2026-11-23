package com.genflowly.di

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.slf4j.MDCContext
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.async as scopeAsync
import kotlinx.coroutines.launch as scopeLaunch

/**
 * Application-wide scope for fire-and-forget background work (embedding sync,
 * key-usage tracking, instruction backfills). Replaces ad-hoc GlobalScope /
 * CoroutineScope(Dispatchers.IO) launches so background jobs are supervised
 * and cancelled together on shutdown (see the ApplicationStopping hook in
 * Application.module).
 *
 * [launch] and [async] shadow the kotlinx extensions so every job carries the
 * launching request's MDC (its request_id). The shared HttpClient stamps
 * X-Request-Id from MDC, so without this a job's calls to the retrieval and
 * encoding servers went out uncorrelated. Launched outside a request, the
 * captured MDC is empty and nothing changes.
 */
class AppScope : CoroutineScope {
    override val coroutineContext: CoroutineContext = SupervisorJob() + Dispatchers.IO

    fun launch(
        context: CoroutineContext = EmptyCoroutineContext,
        start: CoroutineStart = CoroutineStart.DEFAULT,
        block: suspend CoroutineScope.() -> Unit,
    ): Job = scopeLaunch(MDCContext() + context, start, block)

    fun <T> async(
        context: CoroutineContext = EmptyCoroutineContext,
        start: CoroutineStart = CoroutineStart.DEFAULT,
        block: suspend CoroutineScope.() -> T,
    ): Deferred<T> = scopeAsync(MDCContext() + context, start, block)

    fun shutdown() = cancel()
}
