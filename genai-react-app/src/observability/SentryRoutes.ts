import * as Sentry from '@sentry/react'
import { Routes } from 'react-router'

/** `<Routes>` that names page-load and navigation timings by route pattern rather than by URL. */
export const SentryRoutes = Sentry.wrapReactRouterRouting(Routes)
