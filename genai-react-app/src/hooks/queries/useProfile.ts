import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import { getUserProfile, loadCachedProfile, saveCachedProfile } from '../../services/userService'
import { CustomerProfileResponse } from '../../models/user.models'
import { PROFILE_QUERY_KEY } from './queryKeys'

/**
 * The customer's profile (GET /api/v1/profile), shared by every profile
 * surface: the previous session's copy paints as placeholder, a fresh fetch
 * revalidates on mount, and the profile mutations in userService write
 * through to this cache — one query instead of each page's own fetch.
 */
export function useProfile() {
    const { isAuthenticated, customerId, getAccessTokenSilently } = useAuth()

    return useQuery<CustomerProfileResponse | null>({
        queryKey: [PROFILE_QUERY_KEY, customerId],
        queryFn: async () => {
            const data = await getUserProfile(await getAccessTokenSilently())
            if (data) saveCachedProfile(data)
            return data
        },
        placeholderData: () => loadCachedProfile(customerId) ?? undefined,
        refetchOnMount: 'always',
        enabled: isAuthenticated && !!customerId,
    })
}
