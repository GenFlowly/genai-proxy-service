import { PublishDefaultGraphRequest } from '../models/defaultGraph.models'

/**
 * The agent-loop template — the Claude-Code-shaped two-node graph: memory +
 * a response generator cycling with TOOL_EXECUTOR until the model stops
 * calling tools. No retrieval pipeline: the model decides per turn whether to
 * search the knowledge base (search_knowledge_base tool) or the web, and how
 * many rounds to take, with maxIterations as the runaway backstop.
 *
 * Mirrors retrieval-server/graph/templates/agent_loop.json — keep the two in
 * sync. entryPoint/edges reference tempIds; the backend substitutes real
 * NOD… ids on publish. The tool_route edge carries no condition_key (the
 * runtime ignores it for this condition type) and its routes are the loop's
 * exit contract: 'builtin' loops through the executor, 'caller' and 'none'
 * end the turn.
 */
export const AGENT_LOOP_TEMPLATE: PublishDefaultGraphRequest = {
    name: 'Agent',
    maxIterations: 40,
    entryPoint: 'memory',
    edges: JSON.stringify({
        edges: [
            { from: 'memory', to: 'generator' },
            { from: 'tools', to: 'generator' },
        ],
        conditional_edges: [
            {
                from: 'generator',
                condition_type: 'tool_route',
                routes: { builtin: 'tools', caller: '__end__', none: '__end__' },
            },
        ],
    }),
    nodes: [
        { tempId: 'memory', nodeType: 'MEMORY', name: 'Memory', config: '{}' },
        {
            tempId: 'generator',
            nodeType: 'RESPONSE_GENERATOR',
            name: 'Agent',
            config: JSON.stringify({
                response_format: 'text',
                include_conversation_history: true,
                is_streaming: true,
                output_key: 'generated_response',
                input_template: '{original_query}',
            }),
        },
        {
            tempId: 'tools',
            nodeType: 'TOOL_EXECUTOR',
            name: 'Tools',
            // search_knowledge_base is explicit-only in the retrieval server
            // (never part of the implicit all-built-ins default), so it MUST
            // be named here or the agent silently loses knowledge-base search.
            config: JSON.stringify({
                tools: ['search_knowledge_base', 'web_search', 'generate_pdf'],
            }),
        },
    ],
}
