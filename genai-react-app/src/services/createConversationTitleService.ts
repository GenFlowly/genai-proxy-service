import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { fetchWithRetry } from "../utils/apiUtils";
import { CreateConversationTitleRequest, CreateConversationTitleResponse } from "../models/createConversationTitle.models";

export const createConversationTitle = async (
    token: string,
    request: CreateConversationTitleRequest
): Promise<CreateConversationTitleResponse> => {
    const response = await fetchWithRetry(endpoints.createConversationTitle, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
    });

    if (!response.ok) {
        throw new Error(`Failed to create conversation title: ${response.statusText}`);
    }

    return response.json();
};
