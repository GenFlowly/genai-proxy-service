import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ThinkingSteps from '../../../../../components/widgets/ConversationWidget/ResponseWidget/ThinkingSteps';
import { ThinkingStep } from '../../../../../models/conversation.models';
import { applyThinkingStep } from '../../../../../utils/thinkingStepUtils';

describe('ThinkingSteps', () => {
    test('renders nothing for an empty list', () => {
        render(<ThinkingSteps steps={[]} />);
        expect(screen.queryByTestId('thinking-step-list')).not.toBeInTheDocument();
    });

    test('a running step shows its live label with a pulse', () => {
        const steps: ThinkingStep[] = [
            { node: 'qa', name: 'Query Analyzer', kind: 'LLM', status: 'running', label: 'Query Analyzer: thinking…' },
        ];
        render(<ThinkingSteps steps={steps} />);

        const step = screen.getByTestId('thinking-step');
        expect(step).toHaveAttribute('data-status', 'running');
        expect(screen.getByText('Query Analyzer: thinking…')).toBeInTheDocument();
        expect(screen.getByTestId('thinking-step-pulse')).toBeInTheDocument();
        // Running steps carry no detail/items/expanders yet
        expect(screen.queryByTestId('thinking-step-items')).not.toBeInTheDocument();
        expect(screen.queryByTestId('thinking-step-prompt')).not.toBeInTheDocument();
    });

    test('running → done transition swaps the label for name + detail', () => {
        const runningStep: ThinkingStep = { node: 'qa', name: 'Query Analyzer', kind: 'LLM', status: 'running', label: 'Query Analyzer: thinking…' };
        let steps = applyThinkingStep([], runningStep);
        const { rerender } = render(<ThinkingSteps steps={steps} />);
        expect(screen.getByText('Query Analyzer: thinking…')).toBeInTheDocument();

        steps = applyThinkingStep(steps, { node: 'qa', name: 'Query Analyzer', kind: 'LLM', status: 'done', detail: 'Intent: lookup (needs rewrite: no)' });
        rerender(<ThinkingSteps steps={steps} />);

        expect(screen.getAllByTestId('thinking-step')).toHaveLength(1);
        expect(screen.getByTestId('thinking-step')).toHaveAttribute('data-status', 'done');
        expect(screen.getByText('Query Analyzer')).toBeInTheDocument();
        expect(screen.getByText('Intent: lookup (needs rewrite: no)')).toBeInTheDocument();
        expect(screen.queryByText('Query Analyzer: thinking…')).not.toBeInTheDocument();
        expect(screen.queryByTestId('thinking-step-pulse')).not.toBeInTheDocument();
    });

    test('done retrieval step lists its items', () => {
        const steps: ThinkingStep[] = [
            {
                node: 'retriever',
                name: 'Document Retriever',
                kind: 'RETRIEVAL',
                status: 'done',
                detail: 'Found 2 relevant document(s)',
                items: ['Q3 sales report', 'Pricing FAQ'],
            },
        ];
        render(<ThinkingSteps steps={steps} />);

        const items = screen.getByTestId('thinking-step-items');
        expect(items).toBeInTheDocument();
        expect(screen.getByText('Q3 sales report')).toBeInTheDocument();
        expect(screen.getByText('Pricing FAQ')).toBeInTheDocument();
    });

    test('prompt and response render behind collapsed expanders', () => {
        const steps: ThinkingStep[] = [
            {
                node: 'qa',
                name: 'Query Analyzer',
                kind: 'LLM',
                status: 'done',
                detail: 'Intent: lookup',
                prompt: 'You are a query analyzer…',
                response: '{"intent":"lookup"}',
            },
        ];
        render(<ThinkingSteps steps={steps} />);

        const promptExpander = screen.getByTestId('thinking-step-prompt');
        const responseExpander = screen.getByTestId('thinking-step-response');

        // Collapsed by default
        expect(promptExpander).not.toHaveAttribute('open');
        expect(responseExpander).not.toHaveAttribute('open');

        // i18n summaries and monospace bodies are present
        expect(screen.getByText('Prompt')).toBeInTheDocument();
        expect(screen.getByText('Response')).toBeInTheDocument();
        expect(screen.getByText('You are a query analyzer…')).toBeInTheDocument();
        expect(screen.getByText('{"intent":"lookup"}')).toBeInTheDocument();
    });

    test('a cycle (same node running again after done) renders as two stacked steps', () => {
        let steps = applyThinkingStep([], { node: 'qa', name: 'Query Analyzer', kind: 'LLM', status: 'running', label: 'Query Analyzer: thinking…' });
        steps = applyThinkingStep(steps, { node: 'qa', name: 'Query Analyzer', kind: 'LLM', status: 'done', detail: 'first pass' });
        steps = applyThinkingStep(steps, { node: 'qa', name: 'Query Analyzer', kind: 'LLM', status: 'running', label: 'Query Analyzer: re-checking…' });
        render(<ThinkingSteps steps={steps} />);

        const rows = screen.getAllByTestId('thinking-step');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveAttribute('data-status', 'done');
        expect(screen.getByText('first pass')).toBeInTheDocument();
        expect(rows[1]).toHaveAttribute('data-status', 'running');
        expect(screen.getByText('Query Analyzer: re-checking…')).toBeInTheDocument();
    });

    test('legacy plain steps (no kind) render label-only rows without an icon', () => {
        const steps: ThinkingStep[] = [
            { node: 'legacy-0', name: 'pondering deeply', status: 'done' },
        ];
        render(<ThinkingSteps steps={steps} />);

        const step = screen.getByTestId('thinking-step');
        expect(screen.getByText('pondering deeply')).toBeInTheDocument();
        expect(step.querySelector('svg')).toBeNull();
    });

    test('kinds map to their lucide icons', () => {
        const steps: ThinkingStep[] = [
            { node: 'a', name: 'LLM node', kind: 'LLM', status: 'done' },
            { node: 'b', name: 'Memory node', kind: 'MEMORY', status: 'done' },
            { node: 'c', name: 'Retrieval node', kind: 'RETRIEVAL', status: 'done' },
            { node: 'd', name: 'Web node', kind: 'WEB_SEARCH', status: 'done' },
            { node: 'e', name: 'Reflection node', kind: 'REFLECTION', status: 'done' },
        ];
        render(<ThinkingSteps steps={steps} />);

        const rows = screen.getAllByTestId('thinking-step');
        expect(rows).toHaveLength(5);
        rows.forEach(row => expect(row.querySelector('svg')).not.toBeNull());
    });
});
