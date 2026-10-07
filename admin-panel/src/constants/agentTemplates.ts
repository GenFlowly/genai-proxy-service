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
/**
 * The v1 harness prompt — loop discipline, planning, knowledge search,
 * scratch files, delegation, stop conditions. To make it fleet-editable
 * without a deploy, create an instruction record with this text and set
 * harness_instruction_id on the generator config instead; this inline text
 * then becomes the fallback.
 */
const HARNESS_PROMPT = [
    'You are an autonomous agent. Work in a loop: plan, act with your tools, ' +
        'observe the results, and continue until the task is complete — then give ' +
        'one final, complete answer.',
    'Planning: for any task with three or more steps, write your plan with ' +
        'write_todos before starting, keep exactly one item in_progress, and mark ' +
        'items completed the moment they are done.',
    "Knowledge: when the answer may depend on the user's own data, search the " +
        'knowledge base with search_knowledge_base before answering, and refine the ' +
        'query and search again if the first results do not cover the question. Use ' +
        'web_search for current public information. Cite sources inline with their ' +
        '[n] markers.',
    'Working files: fs_write/fs_read/fs_list are your private scratch space for ' +
        'notes and large intermediate results. Oversized tool outputs are saved ' +
        'there automatically — re-read them with fs_read instead of re-running the tool.',
    'Delegation: for substantial self-contained subtasks, spawn_agent runs a ' +
        'subagent that works autonomously and returns one report. Its prompt must be ' +
        'complete and self-contained (it sees nothing of this conversation). Prefer ' +
        'several spawn_agent calls in one turn for independent subtasks. Never ' +
        'delegate trivial work.',
    'Discipline: do not call tools for things you already know. Stop as soon as ' +
        'you can answer well. If tools fail repeatedly, say what you tried and ' +
        'answer with what you have, stating what is unverified.',
].join('\n\n')

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
                // Turn token budget: past this, the generator binds no tools
                // and must produce its final answer.
                max_turn_tokens: 120000,
                // Older tool rounds fold into an LLM-written summary past this.
                compaction_threshold_tokens: 40000,
                harness_prompt: HARNESS_PROMPT,
            }),
        },
        {
            tempId: 'tools',
            nodeType: 'TOOL_EXECUTOR',
            name: 'Tools',
            // All harness tools are explicit-only in the retrieval server
            // (never part of the implicit all-built-ins default), so each MUST
            // be named here or the agent silently loses that capability.
            // subagents: [] means only the built-in 'general' profile; add
            // {name, description, prompt|instruction_id, tools} entries to
            // define specialists.
            config: JSON.stringify({
                tools: [
                    'search_knowledge_base',
                    'web_search',
                    'generate_pdf',
                    'write_todos',
                    'fs_write',
                    'fs_read',
                    'fs_list',
                    'spawn_agent',
                ],
                subagents: [],
            }),
        },
    ],
}
