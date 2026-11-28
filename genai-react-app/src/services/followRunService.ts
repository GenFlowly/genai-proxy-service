import { ActivityEvent } from "@genflowly/component-library";
import { reattachRun } from "./reattachRunService";
import { StreamCallbacks, StreamGenerationError, StreamTruncatedError } from "./generateTextStreamService";

/**
 * Where a reply's durable run has got to on this page: the run, and the last
 * event applied. A dropped stream reattaches after `lastSeq`, so nothing is
 * shown twice or lost. `active` turns false once a reattach finds the run over:
 * its reply is saved and nothing more will stream.
 */
export interface RunCursor {
    runId?: string;
    lastSeq: number;
    active: boolean;
}

export const newRunCursor = (runId?: string): RunCursor => ({ runId, lastSeq: 0, active: true });

/** A reply whose recovery gave up after several attempts while the page could reach the server. */
export class ReplyRecoveryFailed extends Error {
    constructor(readonly underlying: unknown) {
        super(`Reply recovery gave up: ${underlying instanceof Error ? underlying.message : String(underlying)}`);
        this.name = "ReplyRecoveryFailed";
    }
}

/**
 * A dropped connection rather than a failure: the tab was hidden or frozen,
 * the network went away, or the page hung up. The server's run carries on, so
 * it's resumed, never reported.
 */
export function isNetworkLoss(error: unknown): boolean {
    if (error instanceof StreamTruncatedError) return true;
    if (error instanceof TypeError) return true; // fetch's "Failed to fetch" / "network error"
    return (error as { name?: string })?.name === "AbortError";
}

/** True while a reconnect can work: the tab is visible and the browser online. */
export function canReachServer(): boolean {
    return document.visibilityState === "visible" && navigator.onLine !== false;
}

/**
 * Resolves once the tab is visible and online. Hidden tabs throttle timers, so
 * a return to the tab is the moment a dropped reply resumes.
 */
export function waitUntilReachable(signal?: AbortSignal): Promise<void> {
    if (canReachServer()) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const check = () => {
            if (signal?.aborted) {
                cleanup();
                reject(new DOMException("Aborted", "AbortError"));
            } else if (canReachServer()) {
                cleanup();
                resolve();
            }
        };
        const cleanup = () => {
            document.removeEventListener("visibilitychange", check);
            window.removeEventListener("online", check);
            signal?.removeEventListener("abort", check);
        };
        document.addEventListener("visibilitychange", check);
        window.addEventListener("online", check);
        signal?.addEventListener("abort", check);
    });
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
});

const MAX_FAILURES = 5;
const backoffMs = (failures: number) => 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 3);

/**
 * Follows a reply's durable run from the last event applied until the run
 * ends, reconnecting whenever the stream drops. Waits while the tab is hidden
 * or offline, and gives up after five failed attempts while it can reach the
 * server, backing off 1, 2, 4, 8 s. Rejects with an AbortError when [signal]
 * aborts (Stop).
 */
export async function followRun(
    getToken: () => Promise<string>,
    cursor: RunCursor,
    conversationId: string,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    delayMs: (failures: number) => number = backoffMs,
): Promise<void> {
    if (!cursor.runId) return;
    let failures = 0;
    for (;;) {
        await waitUntilReachable(signal);
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const token = await getToken();
            cursor.active = (await reattachRun(token, cursor.runId, conversationId, callbacks, cursor.lastSeq, signal)) !== false;
            return;
        } catch (error: any) {
            if (signal?.aborted || error?.name === "AbortError") throw new DOMException("Aborted", "AbortError");
            if (error instanceof StreamGenerationError) throw error;
            if (typeof error?.status === "number" && error.status >= 400 && error.status < 500) throw error;
            if (error?.error === "login_required" || error?.error === "consent_required") throw error;
            if (canReachServer()) failures++;
            if (failures >= MAX_FAILURES) throw new ReplyRecoveryFailed(error);
            await sleep(delayMs(failures), signal);
        }
    }
}

/**
 * The server's clock for the turn, as an activity entry: the thinking panel's
 * live clock anchors on the newest `at` it holds, and the reducer drops this
 * unknown type, so it moves the clock without becoming a step. After a
 * reconnect the newest real event can be long past.
 */
export const turnClockEvent = (elapsedMs: number): ActivityEvent =>
    ({ v: 2, at: elapsedMs, type: "turn.clock" } as unknown as ActivityEvent);
