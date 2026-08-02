import { endpoints } from "../config/endpoints";
import { HttpMethod } from "../constants/http";
import { fetchWithRetry } from "../utils/apiUtils";
import { SearchUserResponse } from "../models/user.models";

export async function searchUserByUsername(token: string, username: string): Promise<SearchUserResponse | null> {
    try {
        const response = await fetchWithRetry(`${endpoints.searchUsers}?username=${encodeURIComponent(username)}`, {
            method: HttpMethod.GET,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
        });

        if (response.status === 404) {
            return null; // Not found or not discoverable
        }

        if (!response.ok) {
            throw new Error(`Search Users failed: ${response.status} ${response.statusText}`);
        }

        return (await response.json()) as SearchUserResponse;
    } catch (error) {
        console.error("Error searching user:", error);
        return null;
    }
}
