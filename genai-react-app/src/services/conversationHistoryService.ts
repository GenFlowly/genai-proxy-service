import { HttpMethod } from '../constants/http';
import { endpoints } from '../config/endpoints';
import { fetchWithRetry } from '../utils/apiUtils';
import { GetCustomerConversationsResponse } from '../models/conversationHistory.models';

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
