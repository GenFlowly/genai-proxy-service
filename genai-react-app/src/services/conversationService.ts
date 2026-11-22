import { moderationErrorFrom } from './moderationService';
import { fetchWithRetry } from "../utils/apiUtils";
import { config } from '../config/env';
import { endpoints } from '../config/endpoints';
import { HttpMethod } from '../constants/http';
import { ConversationBlock, LearnedFact, Message, MessageSender, WebSource } from '../models/conversation.models';
import { ActivityEvent, isActivityEvent } from '@genflowly/component-library';
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
    /** True while a durable run is still generating this response (empty text,
     *  no usage yet) — surfaced so the client can render the in-flight card and
     *  reattach by this deterministic messageId. */
    inFlight?: boolean;
    /** For an in-flight placeholder: the durable run to reattach to for this
     *  response (one per vendor in a multi-vendor turn). */
    runId?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    tokensReadFromCache?: number | null;
    costUsd?: number | null;
    /** Vendor's raw finish reason for the turn (end_turn / max_tokens / refusal / …) */
    stopReason?: string | null;
    /** The turn's activity log (the "ac" events), as persisted with the message */
    activity?: ActivityEvent[] | null;
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
    /** The user message's own id — carried onto each response below as previousMessageId, for Regenerate to target. */
    promptMessageId?: string | null;
}

interface BackendGetConversationResponse {
    promptAndResponseList: BackendPromptAndResponse[];
    title?: string | null;
    role?: ConversationRole;
    /** Durable run currently generating this conversation's reply, if any. */
    pendingRunId?: string | null;
}

/** An in-flight durable run to reattach to on reload, and the response message it feeds. */
export interface PendingRunRef {
    messageId: string;
    runId: string;
}

export interface GetConversationResponse {
    conversationId: string;
    blocks: ConversationBlock[];
    title?: string | null;
    instructionId?: string | null;
    role: ConversationRole;
    /** Set when a durable run is mid-flight — the client reattaches to its stream.
     *  Kept for back-compat; prefer `pendingRuns` (one per vendor). */
    pendingRunId?: string | null;
    /** Every in-flight run for the latest turn — one per vendor. The client
     *  reattaches to each, feeding its own response card. */
    pendingRuns?: PendingRunRef[];
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

    // In-flight durable runs (one per vendor) surfaced as placeholders, collected
    // so loadConversation can reattach to each on reload.
    const pendingRuns: PendingRunRef[] = [];

    const blocks: ConversationBlock[] = data.promptAndResponseList.map((item, index) => {
        const responses: Message[] = [];

        const responsesToProcess = item.responses && item.responses.length > 0 
            ? item.responses 
            : [];

        responsesToProcess.forEach((resp, respIndex) => {
            // Map responses with text, plus an in-flight placeholder (empty text)
            // for a durable run still generating — the latter must survive so the
            // client can render the loading card and reattach to its stream. A
            // reply with only a stop reason (stopped before any text, or a
            // refusal) is kept too: its note is all that explains the empty card.
            if (resp && (resp.text || resp.inFlight || resp.stopReason)) {
                // Map backend vendor string to frontend Enum if possible, default to something safe or keep string
                const vendor = (resp.aiVendor as AIVendor) || AIVendor.OPENAI;

                responses.push({
                    aiVendor: vendor,
                    model: resp.model ?? null,
                    text: resp.text ?? '',
                    messageId: resp.messageId || `msg-${index}-${respIndex}`,
                    // The turn's user message id — lets Regenerate target this
                    // exact turn instead of guessing from a response's id.
                    previousMessageId: item.promptMessageId ?? undefined,
                    // In-flight placeholder renders as a generating card (spinner),
                    // never the "No responses were generated" empty state.
                    isLoading: resp.inFlight ?? false,
                    inputTokens: resp.inputTokens ?? null,
                    outputTokens: resp.outputTokens ?? null,
                    totalTokens: resp.totalTokens ?? null,
                    tokensReadFromCache: resp.tokensReadFromCache ?? null,
                    costUsd: resp.costUsd ?? null,
                    stopReason: resp.stopReason ?? null,
                    // An in-flight placeholder's log continues over the reattach
                    // stream, which replays it from the start.
                    activity: resp.inFlight ? [] : (resp.activity ?? []).filter(isActivityEvent),
                    webSources: resp.webSources ?? null,
                    generatedAttachments: resp.generatedAttachments ?? null,
                    // Always set for historical messages (null = extraction
                    // outcome unknown) so the UI knows not to poll for them
                    learnedFacts: resp.learnedFacts ?? null,
                });
                // An in-flight placeholder carries the run to reattach to; collect
                // it so every vendor's run is resumed on reload (not just one).
                if (resp.inFlight && resp.runId && resp.messageId) {
                    pendingRuns.push({ messageId: resp.messageId, runId: resp.runId });
                }
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
            isLoading: responses.some(r => r.isLoading),
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
        pendingRuns,
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
        throw await moderationErrorFrom(response, 'Share Conversation failed');
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
