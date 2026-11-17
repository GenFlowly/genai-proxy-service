import { HttpMethod } from '../constants/http';
import { endpoints } from '../config/endpoints';
import { fetchWithRetry } from '../utils/apiUtils';
import { queryClient } from '../queryClient';
import { MEMORIES_QUERY_KEY, PROJECTS_QUERY_KEY } from '../hooks/queries/queryKeys';
import {
    patchHistoryCache,
    withoutProject,
    withRenamedProject,
} from '../components/widgets/ConversationHistoryWidget/historyCache';
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

/**
 * One page of a project's conversations, most recently updated first —
 * served by the sparse projectIndex GSI, so a project's full membership is
 * readable without touching the recents/pinned lists. A page can come back
 * shorter than pageSize (the server drops archived members after the index
 * read); follow lastEvaluatedKey, not the page length.
 */
export const getProjectConversations = async (
    token: string,
    projectId: string,
    pageSize: number = 50,
    lastEvaluatedKey?: string | null
): Promise<GetCustomerConversationsResponse> => {
    const params = new URLSearchParams({ projectId, pageSize: String(pageSize) });
    if (lastEvaluatedKey) {
        params.set('lastEvaluatedKey', lastEvaluatedKey);
    }

    const response = await fetchWithRetry(
        `${endpoints.getProjectConversations}?${params.toString()}`,
        {
            method: HttpMethod.GET,
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fetch project conversations: ${response.statusText}`);
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

/**
 * Renames the project. The server trims the name (1 to 100 characters); the
 * trimmed name goes into every cached copy of the project and of its
 * conversations' summaries.
 */
export const renameProject = async (
    token: string,
    projectId: string,
    name: string
): Promise<void> => {
    const response = await fetchWithRetry(endpoints.renameProject(projectId), {
        method: HttpMethod.POST,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name }),
    });

    if (!response.ok) {
        throw new Error(`Failed to rename project: ${response.statusText}`);
    }

    const trimmed = name.trim();
    patchHistoryCache(state => withRenamedProject(state, projectId, trimmed));
    queryClient.setQueriesData<Project[]>(
        { queryKey: [PROJECTS_QUERY_KEY] },
        (old: Project[] | undefined) => old?.map(p => (p.projectId === projectId ? { ...p, name: trimmed } : p))
    );
};

/**
 * Deletes the project. Its conversations stay and return to the global
 * history; memories that belonged only to this project are deleted with it,
 * so the memory lists are refetched. A project that is already gone counts
 * as deleted.
 */
export const deleteProject = async (
    token: string,
    projectId: string
): Promise<void> => {
    const response = await fetchWithRetry(endpoints.deleteProject(projectId), {
        method: HttpMethod.DELETE,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete project: ${response.statusText}`);
    }

    patchHistoryCache(state => withoutProject(state, projectId));
    queryClient.setQueriesData<Project[]>(
        { queryKey: [PROJECTS_QUERY_KEY] },
        (old: Project[] | undefined) => old?.filter(p => p.projectId !== projectId)
    );
    void queryClient.invalidateQueries({ queryKey: [MEMORIES_QUERY_KEY] });
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

/** Permanently deletes the conversation, everywhere it is stored. */
export const deleteConversation = async (
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
        throw new Error(`Failed to delete conversation: ${response.statusText}`);
    }
};
