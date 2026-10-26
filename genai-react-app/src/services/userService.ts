import { endpoints } from "../config/endpoints";
import { HttpMethod } from "../constants/http";
import { fetchWithRetry } from "../utils/apiUtils";
import { SearchUserResponse, CustomerProfileResponse } from "../models/user.models";
import i18n from "../i18n";

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

        return true;
    } catch (error) {
        console.error("Error updating discoverability:", error);
        return false;
    }
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
