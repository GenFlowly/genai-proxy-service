import { HttpMethod } from '../constants/http';
import { endpoints } from '../config/endpoints';
import { fetchWithRetry } from '../utils/apiUtils';
import { GetCustomerConversationsResponse, GetPinnedConversationsResponse } from '../models/conversationHistory.models';

export const getCustomerConversations = async (
    token: string,
    pageSize: number = 10,
    lastEvaluatedKey?: string | null
): Promise<GetCustomerConversationsResponse> => {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (lastEvaluatedKey) {
        params.set('lastEvaluatedKey', lastEvaluatedKey);
    }

    const response = await fetchWithRetry(
        `${endpoints.getCustomerConversations}?${params.toString()}`,
        {
            method: HttpMethod.GET,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fetch conversations: ${response.statusText}`);
    }

    return response.json();
};

export const getPinnedConversations = async (
    token: string
): Promise<GetPinnedConversationsResponse> => {
    const response = await fetchWithRetry(endpoints.getPinnedConversations, {
        method: HttpMethod.GET,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch pinned conversations: ${response.statusText}`);
    }

    return response.json();
};

export const pinConversation = async (
    token: string,
    conversationId: string
): Promise<void> => {
    const response = await fetchWithRetry(
        endpoints.pinConversation(conversationId),
        {
            method: HttpMethod.POST,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to pin conversation: ${response.statusText}`);
    }
};

export const unpinConversation = async (
    token: string,
    conversationId: string
): Promise<void> => {
    const response = await fetchWithRetry(
        endpoints.unpinConversation(conversationId),
        {
            method: HttpMethod.POST,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to unpin conversation: ${response.statusText}`);
    }
};

export const archiveConversation = async (
    token: string,
    conversationId: string
): Promise<void> => {
    const response = await fetchWithRetry(
        endpoints.deleteConversation(conversationId),
        {
            method: HttpMethod.DELETE,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to archive conversation: ${response.statusText}`);
    }
};

export const unarchiveConversation = async (
    token: string,
    conversationId: string
): Promise<void> => {
    const response = await fetchWithRetry(
        endpoints.unarchiveConversation(conversationId),
        {
            method: HttpMethod.POST,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to unarchive conversation: ${response.statusText}`);
    }
};
