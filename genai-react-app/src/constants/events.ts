/**
 * Window-level custom events bridging contexts and component-local state.
 *
 * The history sidebar owns its conversation list in component-local state
 * (fetched on mount), so actions performed elsewhere that must appear in the
 * list immediately — like forking a conversation — announce themselves here.
 */

/** detail: ForkConversationResponse — a conversation was just forked. */
export const CONVERSATION_FORKED_EVENT = 'genflowly:conversation-forked';
