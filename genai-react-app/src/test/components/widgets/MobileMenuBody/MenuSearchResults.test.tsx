import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import MenuSearchResults from '../../../../components/widgets/MobileMenuBody/MenuSearchResults'
import { searchContent, SearchResultItem } from '../../../../services/searchService'

jest.mock('../../../../services/searchService')
jest.mock('../../../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('token') }),
}))

const mockSearch = searchContent as jest.Mock

const result: SearchResultItem = {
    type: 'conversation',
    key: 'conv-1',
    title: 'Tax questions',
    snippet: 'What can I deduct',
    score: 0.9,
    matchedChunks: 1,
}

const renderResults = (onSelect = jest.fn()) => {
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <MenuSearchResults query="tax" types={['conversation']} untitledLabel="Untitled" onSelect={onSelect} />
        </QueryClientProvider>
    )
    return onSelect
}

describe('MenuSearchResults', () => {
    beforeEach(() => mockSearch.mockReset())

    test('sends the query and lists results with their snippets', async () => {
        mockSearch.mockResolvedValue([result])
        const onSelect = renderResults()

        expect(await screen.findByText('Tax questions')).toBeInTheDocument()
        expect(screen.getByText('What can I deduct')).toBeInTheDocument()
        expect(mockSearch).toHaveBeenCalledWith('token', 'tax', ['conversation'])

        await userEvent.click(screen.getByTestId('menu-search-result-conv-1'))
        expect(onSelect).toHaveBeenCalledWith(result)
    })

    test('labels a result that has no title', async () => {
        mockSearch.mockResolvedValue([{ ...result, title: null }])
        renderResults()
        expect(await screen.findByText('Untitled')).toBeInTheDocument()
    })

    test('says when nothing matched', async () => {
        mockSearch.mockResolvedValue([])
        renderResults()
        expect(await screen.findByText('No results')).toBeInTheDocument()
    })

    test('says when the search failed', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        mockSearch.mockRejectedValue(new Error('500'))
        renderResults()
        await waitFor(() => expect(screen.getByText('Search failed. Try again.')).toBeInTheDocument())
    })
})
