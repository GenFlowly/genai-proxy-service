import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import { SearchDataType, searchContent } from '../../services/searchService'

const SEARCH_DEBOUNCE_MS = 300

/** Semantic search over the customer's data, sent once typing pauses. */
export function useContentSearch(query: string, types: SearchDataType[]) {
    const { getAccessTokenSilently } = useAuth()
    const trimmed = query.trim()
    const [debounced, setDebounced] = useState(trimmed)

    useEffect(() => {
        const timer = setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
    }, [trimmed])

    return useQuery({
        queryKey: ['content-search', types, debounced],
        queryFn: async () => searchContent(await getAccessTokenSilently(), debounced, types),
        enabled: debounced.length > 0,
    })
}
