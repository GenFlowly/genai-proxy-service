import { User } from '@auth0/auth0-react'
import { endpoints } from '../config/endpoints'

const CLIENT_IDENTIFIER = 'ADMIN_PANEL'

/**
 * Ensure a CustomerProfile exists for the logged-in account. The admin
 * allowlist check matches against the profile's stored email, so a fresh
 * Auth0 account must onboard once before any /admin endpoint will accept it.
 * Idempotent — returns the existing profile for known accounts.
 */
export async function onboardCustomer(token: string, user: User): Promise<void> {
    const response = await fetch(endpoints.onboardCustomer, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            sub: user.sub,
            client: CLIENT_IDENTIFIER,
            email: user.email,
            name: user.name,
            picture: user.picture,
        }),
    })

    if (!response.ok) {
        throw new Error(`Onboarding failed: ${response.status} ${response.statusText}`)
    }
}
