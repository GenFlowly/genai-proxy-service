import { HttpMethod } from '../constants/http';
import { endpoints } from '../config/endpoints';
import { fetchWithRetry } from '../utils/apiUtils';
import {
    ForkConversationResponse,
    GetCustomerConversationsResponse,
    GetPinnedConversationsResponse,
    GetProjectsResponse,
    Project,
} from '../models/conversationHistory.models';

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

export const forkConversation = async (
    token: string,
    conversationId: string,
    messageId: string
): Promise<ForkConversationResponse> => {
    const response = await fetchWithRetry(
        endpoints.forkConversation(conversationId, messageId),
        {
            method: HttpMethod.POST,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fork conversation: ${response.statusText}`);
    }

    return response.json();
};

export const getProjects = async (token: string): Promise<GetProjectsResponse> => {
    const response = await fetchWithRetry(endpoints.getProjects, {
        method: HttpMethod.GET,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch projects: ${response.statusText}`);
    }

    return response.json();
};

export const createProject = async (
    token: string,
    name: string
): Promise<Project> => {
    const response = await fetchWithRetry(endpoints.createProject, {
        method: HttpMethod.POST,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name }),
    });

    if (!response.ok) {
        throw new Error(`Failed to create project: ${response.statusText}`);
    }

    return response.json();
};

export const assignConversationToProject = async (
    token: string,
    conversationId: string,
    projectId: string
): Promise<void> => {
    const response = await fetchWithRetry(
        endpoints.assignConversationProject(conversationId, projectId),
        {
            method: HttpMethod.POST,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to assign conversation to project: ${response.statusText}`);
    }
};

export const unassignConversationFromProject = async (
    token: string,
    conversationId: string
): Promise<void> => {
    const response = await fetchWithRetry(
        endpoints.unassignConversationProject(conversationId),
        {
            method: HttpMethod.POST,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to unassign conversation from project: ${response.statusText}`);
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
