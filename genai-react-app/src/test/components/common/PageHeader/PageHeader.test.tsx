import React from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import PageHeader from '../../../../components/common/PageHeader/PageHeader'

describe('PageHeader', () => {
    test('renders the title', () => {
        render(<PageHeader title="My Page" />)

        expect(screen.getByText('My Page')).toBeInTheDocument()
        expect(screen.getByText('My Page')).toHaveAttribute('title', 'My Page')
    })

    test('renders actions when provided', () => {
        render(<PageHeader title="My Page" actions={<button>Do it</button>} />)

        expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument()
    })

    test('renders children (e.g. modals)', () => {
        render(
            <PageHeader title="My Page">
                <div data-testid="modal-slot" />
            </PageHeader>
        )

        expect(screen.getByTestId('modal-slot')).toBeInTheDocument()
    })

    test('forwards data-testid', () => {
        render(<PageHeader title="My Page" data-testid="page-header" />)

        expect(screen.getByTestId('page-header')).toBeInTheDocument()
    })
})
