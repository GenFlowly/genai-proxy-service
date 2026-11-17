import { useEffect, useState } from 'react'
import { DateRange } from '@genflowly/component-library'
import { useAuth } from '../../../../context/AuthContext'
import { toUtcUsageRange } from './usageDateRange'

/**
 * Fetches one usage summary for the picked local range (sent as the UTC
 * days it touches) and refetches when the range changes. `load` must be
 * stable, e.g. a service function. A null summary means the category isn't
 * tracked yet.
 */
export function useUsageSummary<T>(
    load: (token: string, range: DateRange) => Promise<T | null>,
    range: DateRange,
    logLabel: string
): { summary: T | null; loading: boolean; error: boolean } {
    const { isAuthenticated, getAccessTokenSilently } = useAuth()
    const [summary, setSummary] = useState<T | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(false)

    useEffect(() => {
        if (!isAuthenticated) return
        let active = true
        setLoading(true)
        setError(false)
        getAccessTokenSilently()
            .then(token => load(token, toUtcUsageRange(range)))
            .then(result => { if (active) setSummary(result) })
            .catch(err => {
                console.error(`${logLabel}: failed to fetch usage`, err)
                if (active) {
                    setSummary(null)
                    setError(true)
                }
            })
            .finally(() => { if (active) setLoading(false) })
        return () => { active = false }
    }, [isAuthenticated, getAccessTokenSilently, load, range, logLabel])

    return { summary, loading, error }
}
