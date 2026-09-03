import { applyThinkingStep } from '../../utils/thinkingStepUtils';
import { ThinkingStep } from '../../models/conversation.models';

const running = (node: string, label?: string): ThinkingStep => ({
    node,
    name: 'Query Analyzer',
    kind: 'LLM',
    status: 'running',
    label: label ?? 'Query Analyzer: thinking…',
});

const done = (node: string, detail?: string): ThinkingStep => ({
    node,
    name: 'Query Analyzer',
    kind: 'LLM',
    status: 'done',
    detail: detail ?? 'Intent: lookup (needs rewrite: no)',
});

describe('applyThinkingStep', () => {
    test('a first running event appends a new entry', () => {
        const result = applyThinkingStep([], running('qa'));
        expect(result).toHaveLength(1);
        expect(result[0].status).toBe('running');
    });

    test('done updates the latest running entry with the same node id', () => {
        const steps = applyThinkingStep([], running('qa'));
        const result = applyThinkingStep(steps, done('qa'));

        expect(result).toHaveLength(1);
        expect(result[0].status).toBe('done');
        expect(result[0].detail).toBe('Intent: lookup (needs rewrite: no)');
    });

    test('a later running after done starts a NEW entry (graph cycle)', () => {
        let steps = applyThinkingStep([], running('qa'));
        steps = applyThinkingStep(steps, done('qa'));
        steps = applyThinkingStep(steps, running('qa', 'Query Analyzer: re-checking…'));

        expect(steps).toHaveLength(2);
        expect(steps[0].status).toBe('done');
        expect(steps[1].status).toBe('running');
        expect(steps[1].label).toBe('Query Analyzer: re-checking…');
    });

    test('done after a cycle updates only the latest entry for that node', () => {
        let steps = applyThinkingStep([], running('qa'));
        steps = applyThinkingStep(steps, done('qa', 'first pass'));
        steps = applyThinkingStep(steps, running('qa'));
        steps = applyThinkingStep(steps, done('qa', 'second pass'));

        expect(steps).toHaveLength(2);
        expect(steps[0].detail).toBe('first pass');
        expect(steps[1].detail).toBe('second pass');
    });

    test('interleaved nodes correlate independently', () => {
        let steps = applyThinkingStep([], running('qa'));
        steps = applyThinkingStep(steps, running('retriever'));
        steps = applyThinkingStep(steps, done('retriever', 'Found 3 relevant document(s)'));
        steps = applyThinkingStep(steps, done('qa'));

        expect(steps).toHaveLength(2);
        expect(steps[0].node).toBe('qa');
        expect(steps[0].status).toBe('done');
        expect(steps[1].node).toBe('retriever');
        expect(steps[1].detail).toBe('Found 3 relevant document(s)');
    });

    test('a done without a prior running is appended as-is', () => {
        const result = applyThinkingStep([], done('qa'));
        expect(result).toHaveLength(1);
        expect(result[0].status).toBe('done');
    });

    test('does not mutate the input array', () => {
        const steps = [running('qa')];
        const result = applyThinkingStep(steps, done('qa'));
        expect(steps[0].status).toBe('running');
        expect(result).not.toBe(steps);
    });
});
