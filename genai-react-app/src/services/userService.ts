import { endpoints } from "../config/endpoints";
import { HttpMethod } from "../constants/http";
import { fetchWithRetry } from "../utils/apiUtils";
import { SearchUserResponse, CustomerProfileResponse } from "../models/user.models";
import i18n from "../i18n";
import { queryClient } from "../queryClient";
import { PROFILE_QUERY_KEY } from "../hooks/queries/queryKeys";
import { createCustomerCache } from "../utils/customerListCache";
import { StorageSuffix } from "../utils/storageKeys";

// SWR seed for the profile (username, name, email, picture, discoverability):
// paints instantly on the next session while the fresh fetch is in flight.
// No credential-adjacent data lives here.
const profileCache = createCustomerCache<CustomerProfileResponse>(StorageSuffix.profile, parsed => {
    const p = parsed as CustomerProfileResponse | null;
    return p && typeof p.customerId === "string" ? p : null;
});

/** Last known profile from a previous session, for instant paint. */
export function loadCachedProfile(customerId: string | null): CustomerProfileResponse | null {
    return profileCache.load(customerId);
}

export function saveCachedProfile(profile: CustomerProfileResponse): void {
    profileCache.save(profile.customerId, profile);
}

// Profile mutations write through here — every consumer of useProfile sees
// the change and the next session paints it, without waiting for a refetch.
function patchProfileCache(partial: Partial<CustomerProfileResponse>): void {
    queryClient.setQueriesData<CustomerProfileResponse | null>(
        { queryKey: [PROFILE_QUERY_KEY] },
        (old: CustomerProfileResponse | null | undefined) => {
            if (!old) return old;
            const next = { ...old, ...partial };
            profileCache.save(next.customerId, next);
            return next;
        }
    );
}

export async function searchUserByUsername(token: string, username: string): Promise<SearchUserResponse[]> {
    try {
        const response = await fetchWithRetry(`${endpoints.searchUsers}?username=${encodeURIComponent(username)}`, {
            method: HttpMethod.GET,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
        });

        if (!response.ok) {
            throw new Error(`Search Users failed: ${response.status} ${response.statusText}`);
        }

        return (await response.json()) as SearchUserResponse[];
    } catch (error) {
        console.error("Error searching user:", error);
        return [];
    }
}

export async function getUserProfile(token: string): Promise<CustomerProfileResponse | null> {
    try {
        const response = await fetchWithRetry(endpoints.getProfile, {
            method: HttpMethod.GET,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
        });

        if (!response.ok) {
            throw new Error(`Get Profile failed: ${response.status} ${response.statusText}`);
        }

        return (await response.json()) as CustomerProfileResponse;
    } catch (error) {
        console.error("Error getting user profile:", error);
        return null;
    }
}

export async function updateUsername(token: string, username: string): Promise<boolean> {
    try {
        const response = await fetchWithRetry(endpoints.updateUsername, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ username }),
        });

        if (response.status === 409) {
            throw new Error(i18n.t("errors.user.usernameTaken"));
        }

        if (!response.ok) {
            throw new Error(i18n.t("errors.user.updateUsernameFailed", { status: response.status, statusText: response.statusText }));
        }

        patchProfileCache({ username });
        return true;
    } catch (error) {
        console.error("Error updating username:", error);
        throw error; // Let the caller handle the 409 error
    }
}

export async function updateDiscoverability(token: string, isDiscoverable: boolean): Promise<boolean> {
    try {
        const response = await fetchWithRetry(endpoints.updateDiscoverability, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ isDiscoverable }),
        });

        if (!response.ok) {
            throw new Error(`Update Discoverability failed: ${response.status} ${response.statusText}`);
        }

        patchProfileCache({ isDiscoverable });
        return true;
    } catch (error) {
        console.error("Error updating discoverability:", error);
        return false;
    }
}

/** Records agreement to the AI data consent screen and returns when, ISO-8601 UTC. */
export async function acceptAiDataConsent(token: string): Promise<string> {
    const response = await fetchWithRetry(endpoints.aiDataConsent, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`AI data consent failed: ${response.status} ${response.statusText}`);
    }

    const { aiDataConsentAt } = await response.json();
    return aiDataConsentAt;
}

export async function completeOnboarding(token: string): Promise<boolean> {
    const response = await fetchWithRetry(endpoints.completeOnboarding, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Complete Onboarding failed: ${response.status} ${response.statusText}`);
    }

    return true;
}
