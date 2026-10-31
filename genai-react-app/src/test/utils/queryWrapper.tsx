import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/** Fresh client per test: no retries, no persisted state between tests. */
export function createTestQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
        },
    })
}

export function withQueryClient(ui: React.ReactElement): React.ReactElement {
    return <QueryClientProvider client={createTestQueryClient()}>{ui}</QueryClientProvider>
}
