import { fetchWithRetry } from "../utils/apiUtils";
import { config } from '../config/env';
import { endpoints } from '../config/endpoints';
import { HttpMethod } from '../constants/http';
import { ConversationBlock, LearnedFact, Message, MessageSender, ThinkingStep, WebSource } from '../models/conversation.models';
import { applyThinkingStep } from '../utils/thinkingStepUtils';
import { AttachmentRef } from '../models/attachment.models';
import { AIVendor } from '../constants/vendors';
import { SearchUserResponse } from '../models/user.models';
import { parseServerDate } from '../utils/timeUtils';

export type ConversationRole = 'OWNER' | 'EDIT' | 'VIEW';

// Backend types matching Kotlin data classes
interface BackendPrompt {
    instructionId: string;
    instructionVersion: string;
    prompt: string;
    attachments?: AttachmentRef[];
}

interface BackendResponse {
    text: string | null;
    aiVendor: string | null;
    model?: string | null;
    conversationId: string | null;
    messageId: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    tokensReadFromCache?: number | null;
    costUsd?: number | null;
    thinkingDurationMs?: number | null;
    /** Raw thinking-step events ("ks" chunks) persisted with the message */
    thinkingSteps?: ThinkingStep[] | null;
    webSources?: WebSource[] | null;
    /** Files built-in tools produced during the turn (e.g. generated PDFs) */
    generatedAttachments?: AttachmentRef[] | null;
    /** Facts memory extraction learned from this exchange; null = unknown/pending */
    learnedFacts?: LearnedFact[] | null;
}

interface BackendPromptAndResponse {
    prompt: BackendPrompt;
    responses?: BackendResponse[];
    /** ISO-8601 createdAt of the user message that carried this prompt */
    promptCreatedAt?: string | null;
    /** Author of the user message (customerId + display name/picture) */
    sender?: MessageSender | null;
}

interface BackendGetConversationResponse {
    promptAndResponseList: BackendPromptAndResponse[];
    title?: string | null;
    role?: ConversationRole;
    /** Durable run currently generating this conversation's reply, if any. */
    pendingRunId?: string | null;
}

export interface GetConversationResponse {
    conversationId: string;
    blocks: ConversationBlock[];
    title?: string | null;
    instructionId?: string | null;
    role: ConversationRole;
    /** Set when a durable run is mid-flight — the client reattaches to its stream. */
    pendingRunId?: string | null;
}

export async function getConversation(
    token: string,
    conversationId: string
): Promise<GetConversationResponse | null> { // Changed return type to include null

    const url = `${config.backend.baseUrl}/api/v1/chat?conversationId=${encodeURIComponent(conversationId)}`;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetchWithRetry(url, { // Changed to fetchWithRetry
        method: 'GET',
        headers,
    });

    if (!response.ok) {
        const err = new Error(`Failed to fetch conversation: ${response.status} ${response.statusText}`) as Error & { status: number }
        err.status = response.status
        throw err
    }

    const data: BackendGetConversationResponse = await response.json();

    const blocks: ConversationBlock[] = data.promptAndResponseList.map((item, index) => {
        const responses: Message[] = [];

        const responsesToProcess = item.responses && item.responses.length > 0 
            ? item.responses 
            : [];

        responsesToProcess.forEach((resp, respIndex) => {
            // Only map if we have minimal valid response data
            if (resp && resp.text) {
                // Map backend vendor string to frontend Enum if possible, default to something safe or keep string
                const vendor = (resp.aiVendor as AIVendor) || AIVendor.OPENAI;

                responses.push({
                    aiVendor: vendor,
                    model: resp.model ?? null,
                    text: resp.text,
                    messageId: resp.messageId || `msg-${index}-${respIndex}`,
                    inputTokens: resp.inputTokens ?? null,
                    outputTokens: resp.outputTokens ?? null,
                    totalTokens: resp.totalTokens ?? null,
                    tokensReadFromCache: resp.tokensReadFromCache ?? null,
                    costUsd: resp.costUsd ?? null,
                    thinkingDurationMs: resp.thinkingDurationMs ?? null,
                    // Persisted raw running/done events fold into the same
                    // per-node list the live "ks" stream builds. Any step
                    // without a done event (aborted stream) must not pulse
                    // forever in a historical view.
                    thinkingStepList: resp.thinkingSteps?.length
                        ? resp.thinkingSteps
                            .reduce(applyThinkingStep, [] as ThinkingStep[])
                            .map(s => s.status === 'running' ? { ...s, status: 'done' as const } : s)
                        : undefined,
                    webSources: resp.webSources ?? null,
                    generatedAttachments: resp.generatedAttachments ?? null,
                    // Always set for historical messages (null = extraction
                    // outcome unknown) so the UI knows not to poll for them
                    learnedFacts: resp.learnedFacts ?? null,
                });
            }
        });

        // Backend timestamp of the user message (UTC-normalized); NaN-guard in
        // case of an unparseable value from older records
        const sentAtMs = parseServerDate(item.promptCreatedAt)?.getTime() ?? NaN;

        return {
            // Use messageId for block ID if available to be stable, otherwise index
            conversationBlockId: item.responses && item.responses.length > 0 && item.responses[0].messageId
                ? `block-${item.responses[0].messageId}`
                : `block-${index}-${Date.now()}`,
            prompt: item.prompt.prompt,
            attachments: item.prompt.attachments ?? [],
            responseMessages: responses,
            isLoading: false,
            status: 'resolved',
            ...(Number.isFinite(sentAtMs) ? { sentAt: sentAtMs } : {}),
            ...(item.sender ? { sender: item.sender } : {})
        };
    });

    // The conversation's instruction can change mid-stream (e.g. a default was
    // applied only after some messages existed), so surface the most recent
    // prompt that carries one rather than the first.
    const lastPromptWithInstruction = [...data.promptAndResponseList]
        .reverse()
        .find(item => item.prompt.instructionId);

    return {
        conversationId,
        blocks,
        title: data.title ?? null,
        instructionId: lastPromptWithInstruction?.prompt.instructionId ?? null,
        role: data.role ?? 'OWNER',
        pendingRunId: data.pendingRunId ?? null,
    };
}

export async function shareConversation(
    token: string,
    conversationId: string,
    targetCustomerId: string,
    role: 'VIEW' | 'EDIT' = 'VIEW'
): Promise<void> {
    const response = await fetchWithRetry(endpoints.conversationShare, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ conversationId, targetCustomerId, role }),
    });

    if (!response.ok) {
        throw new Error(`Share Conversation failed: ${response.status} ${response.statusText}`);
    }
}

export async function unshareConversation(
    token: string,
    conversationId: string,
    targetCustomerId: string
): Promise<void> {
    const url = `${endpoints.conversationShare}?conversationId=${encodeURIComponent(conversationId)}&targetCustomerId=${encodeURIComponent(targetCustomerId)}`;
    const response = await fetchWithRetry(url, {
        method: HttpMethod.DELETE,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Unshare Conversation failed: ${response.status} ${response.statusText}`);
    }
}

export async function getConversationSharedUsers(
    token: string,
    conversationId: string
): Promise<SearchUserResponse[]> {
    const response = await fetchWithRetry(endpoints.conversationSharedUsers(conversationId), {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Get Conversation Shared Users failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as SearchUserResponse[];
}
