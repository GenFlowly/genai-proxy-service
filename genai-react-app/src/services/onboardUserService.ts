import { User } from '../types/auth.types'
import { endpoints } from '../config/endpoints'
import { HttpMethod } from '../constants/http'
import { OnboardCustomerResponse } from '../models/onboardUser.models'

const CLIENT_IDENTIFIER = 'REACT_APP'

export async function onboardCustomer(
    user: User,
    token: string
): Promise<OnboardCustomerResponse> {
    const response = await fetch(endpoints.onboardCustomer, {
        method: HttpMethod.POST,
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
