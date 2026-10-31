import { QueryClient } from '@tanstack/react-query'

/**
 * Singleton so non-React code (AuthContext.logout) can clear it. Defaults
 * preserve the app's pre-react-query behavior: no refetch-on-focus (the only
 * focus hook is AuthContext's visibilitychange session check) and no
 * query-level retries — fetchWithRetry already retries transient failures,
 * stacking retries on top would multiply them.
 */
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: 0,
        },
    },
})
