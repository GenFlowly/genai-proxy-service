import { User } from '../types/auth.types'
import { endpoints } from '../config/endpoints'
import { HttpMethod } from '../constants/http'
import { OnboardCustomerResponse } from '../models/onboardUser.models'
import { fetchWithRetry } from "../utils/apiUtils";

const CLIENT_IDENTIFIER = 'REACT_APP'

export async function onboardCustomer(
    user: User,
    token: string
): Promise<OnboardCustomerResponse> {
    const response = await fetchWithRetry(endpoints.onboardCustomer, {
        method: HttpMethod.POST,
        // Background sync — fail fast instead of a long backoff ladder;
        // AuthContext schedules deferred re-attempts (timer/tab-visibility)
        retries: 1,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            ...user,
            client: CLIENT_IDENTIFIER,
        }),
    })

    if (!response.ok) {
        throw new Error(`Backend sync failed: ${response.status} ${response.statusText}`)
    }

    return response.json()
}
