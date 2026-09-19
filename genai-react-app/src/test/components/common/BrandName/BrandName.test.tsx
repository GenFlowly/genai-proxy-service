import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Display names come from the provider catalog (single source of truth);
// the hook is mocked with catalog-shaped names here.
jest.mock('../../../../hooks/useVendorDisplayNames', () => ({
    useVendorDisplayNames: () => (vendorId: string) =>
        ({ OPENAI: 'OpenAI', CLAUDE: 'Anthropic', GEMINI: 'Google Gemini' } as Record<string, string>)[vendorId] ?? vendorId,
}));

import BrandName, {
    VendorBrandName,
    CollapsedVendorBrandName,
    UserBrandName,
} from '../../../../components/common/BrandName/BrandName';

describe('BrandName Components', () => {

    describe('Generic BrandName', () => {
        test('renders the name as plain text (no logo)', () => {
            render(<BrandName name="Test Brand" />);

            const container = screen.getByTestId('brand-name-container');
            expect(container).toBeInTheDocument();
            expect(screen.getByTestId('brand-name-text')).toHaveTextContent('Test Brand');
        });

        test('renders as a custom element (e.g. h1)', () => {
            render(<BrandName name="Heading Brand" as="h1" />);
            const container = screen.getByTestId('brand-name-container');
            expect(container.tagName).toBe('H1');
        });
    });

    describe('VendorBrandName (catalog-sourced names)', () => {
        test('renders the catalog display name for a stored vendor id', () => {
            render(<VendorBrandName vendorId="OPENAI" />);
            expect(screen.getByTestId('brand-name-text')).toHaveTextContent('OpenAI');
        });

        test('uses the catalog name, not the legacy id spelling', () => {
            render(<VendorBrandName vendorId="CLAUDE" />);
            expect(screen.getByTestId('brand-name-text')).toHaveTextContent('Anthropic');
        });
    });

    describe('CollapsedVendorBrandName (vendor initials)', () => {
        test('renders the display-name initial with the vendor testid', () => {
            render(<CollapsedVendorBrandName vendorId="OPENAI" />);
            const badge = screen.getByTestId('collapsed-openai-brand');
            expect(badge).toHaveTextContent('O');
            expect(badge).toHaveAttribute('aria-label', 'OpenAI');
        });

        test('derives the initial from the catalog display name', () => {
            render(<CollapsedVendorBrandName vendorId="CLAUDE" />);
            const badge = screen.getByTestId('collapsed-claude-brand');
            expect(badge).toHaveTextContent('A');
            expect(badge).toHaveAttribute('aria-label', 'Anthropic');
        });

        test('renders long-tail vendors from their id', () => {
            render(<CollapsedVendorBrandName vendorId="groq" />);
            const badge = screen.getByTestId('collapsed-groq-brand');
            expect(badge).toHaveTextContent('G');
            expect(badge).toHaveAttribute('aria-label', 'groq');
        });
    });

    describe('UserBrandName', () => {
        test('renders with name and picture', () => {
            const pictureUrl = 'https://example.com/pic.jpg';
            render(<UserBrandName name="Test User" picture={pictureUrl} />);

            expect(screen.getByTestId('user-brand-name-text')).toHaveTextContent('Test User');
            const img = screen.getByRole('img');
            expect(img).toHaveAttribute('src', pictureUrl);
            expect(img).toHaveAttribute('alt', 'Test User');
        });

        test('renders with default icon when picture is missing', () => {
            render(<UserBrandName name="No Pic User" />);
            expect(screen.getByTestId('user-brand-name-text')).toHaveTextContent('No Pic User');
        });
    });
});
