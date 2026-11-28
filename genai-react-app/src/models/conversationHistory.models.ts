export interface ConversationSummary {
    conversationId: string;
    title: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    pinnedAt?: string | null;
    vendors?: string[];
    // Project association; absent until the backend ships projects. The
    // history panel groups conversations carrying these under a Projects
    // section and hides that section while no conversation has one.
    projectId?: string | null;
    projectName?: string | null;
    // Conversation this one was forked from; the history panel nests forks
    // under their parent (when the parent is visible in the same section).
    parentConversationId?: string | null;
    // A reply arrived after the owner last read it: the row shows a dot.
    unread?: boolean;
}

/** POST /conversation/fork — the newly created forked conversation. */
export interface ForkConversationResponse {
    conversationId: string;
    title: string;
    parentConversationId: string;
    projectId?: string | null;
    pinnedAt?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
}

export interface GetCustomerConversationsResponse {
    conversations: ConversationSummary[];
    lastEvaluatedKey: string | null;
}

export interface GetPinnedConversationsResponse {
    conversations: ConversationSummary[];
}

export interface Project {
    projectId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
}

export interface GetProjectsResponse {
    projects: Project[];
}
