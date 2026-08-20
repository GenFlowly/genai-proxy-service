package com.genflowly.di

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlin.coroutines.CoroutineContext

/**
 * Application-wide scope for fire-and-forget background work (embedding sync,
 * key-usage tracking, instruction backfills). Replaces ad-hoc GlobalScope /
 * CoroutineScope(Dispatchers.IO) launches so background jobs are supervised
 * and cancelled together on shutdown (see the ApplicationStopping hook in
 * Application.module).
 */
class AppScope : CoroutineScope {
    override val coroutineContext: CoroutineContext = SupervisorJob() + Dispatchers.IO

    fun shutdown() = cancel()
}
