import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import MobileMenuBody from '../../../../components/widgets/MobileMenuBody/MobileMenuBody'

describe('MobileMenuBody', () => {
    const renderBody = (results?: React.ReactNode, onSearchChange = jest.fn()) => {
        render(
            <MobileMenuBody
                searchValue="tax"
                onSearchChange={onSearchChange}
                searchPlaceholder="Search chats"
                results={results}
            >
                <div>Cards</div>
            </MobileMenuBody>
        )
        return onSearchChange
    }

    test('shows the cards and reports search text', () => {
        const onSearchChange = renderBody()
        expect(screen.getByText('Cards')).toBeVisible()
        fireEvent.change(screen.getByTestId('mobile-menu-search'), { target: { value: 'taxes' } })
        expect(onSearchChange).toHaveBeenCalledWith('taxes')
    })

    test('keeps the cards mounted but hidden while results show', () => {
        renderBody(<div>Results</div>)
        expect(screen.getByText('Results')).toBeVisible()
        expect(screen.getByTestId('mobile-menu-cards')).toHaveAttribute('hidden')
        expect(screen.getByText('Cards')).toBeInTheDocument()
    })
})
