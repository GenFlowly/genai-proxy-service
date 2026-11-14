/**
 * Window-level custom events bridging contexts and component-local state.
 *
 * The history sidebar owns its conversation list in component-local state
 * (fetched on mount), so actions performed elsewhere that must appear in the
 * list immediately — like forking a conversation — announce themselves here.
 */

/** detail: ForkConversationResponse — a conversation was just forked. */
export const CONVERSATION_FORKED_EVENT = 'genflowly:conversation-forked';

/** Conversations left the list from outside it, e.g. blocking someone removed what they shared. */
export const CONVERSATION_LIST_CHANGED_EVENT = 'genflowly:conversation-list-changed';
