import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChatMenuContent from '../../../../components/widgets/ConversationHeader/ChatMenuContent'

const mockNavigate = jest.fn()
jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}))
jest.mock('../../../../components/widgets/ConversationHistoryWidget/ConversationHistoryComponent', () => ({
    __esModule: true,
    default: ({ menu }: { menu: boolean }) => <div data-testid="history">{String(menu)}</div>,
}))
jest.mock('../../../../components/widgets/MobileMenuBody/MenuSearchResults', () => ({
    __esModule: true,
    default: ({ query, types, onSelect }: any) => (
        <button data-testid="result" onClick={() => onSelect({ key: 'conv-1' })}>
            {query} {types.join(',')}
        </button>
    ),
}))

describe('ChatMenuContent', () => {
    test('shows history until there is a query, then conversation results', () => {
        const onClose = jest.fn()
        render(<ChatMenuContent onClose={onClose} />)

        expect(screen.getByTestId('history')).toHaveTextContent('true')
        expect(screen.queryByTestId('result')).not.toBeInTheDocument()

        fireEvent.change(screen.getByTestId('mobile-menu-search'), { target: { value: 'tax' } })
        expect(screen.getByTestId('result')).toHaveTextContent('tax conversation')

        fireEvent.click(screen.getByTestId('result'))
        expect(mockNavigate).toHaveBeenCalledWith('/chat/conv-1')
        expect(onClose).toHaveBeenCalled()
    })
})
