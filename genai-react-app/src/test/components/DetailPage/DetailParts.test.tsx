import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import '@testing-library/jest-dom'
import { DetailRows, DiffText, MoreMenu } from '../../../components/DetailPage/DetailParts'

describe('MoreMenu', () => {
    test('opens on click, runs an item and closes; Escape and an outside click close it', async () => {
        const onDelete = jest.fn()
        render(
            <div>
                <span>outside</span>
                <MoreMenu label="More actions" items={[{ label: 'Delete', onSelect: onDelete, danger: true, testId: 'delete' }]} />
            </div>,
        )

        await userEvent.click(screen.getByTestId('detail-more'))
        await userEvent.click(screen.getByTestId('delete'))
        expect(onDelete).toHaveBeenCalled()
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()

        await userEvent.click(screen.getByTestId('detail-more'))
        await userEvent.keyboard('{Escape}')
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()

        await userEvent.click(screen.getByTestId('detail-more'))
        await userEvent.click(screen.getByText('outside'))
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    test('with nothing to offer it shows nothing', () => {
        const { container } = render(<MoreMenu label="More" items={[]} />)
        expect(container).toBeEmptyDOMElement()
    })
})

describe('DetailRows', () => {
    test('a row without a destination is plain text', () => {
        render(
            <MemoryRouter>
                <DetailRows label="About" rows={[{ key: 'sharing', icon: 'x.svg', title: 'Sharing', summary: 'Shared with you' }]} />
            </MemoryRouter>,
        )
        expect(screen.getByTestId('detail-row-sharing').tagName).toBe('DIV')
    })
})

describe('DiffText', () => {
    test('a replaced word and its replacement are kept apart', () => {
        render(<p data-testid="replace"><DiffText before="Prefers short answers." after="Prefers concise answers." /></p>)
        expect(screen.getByTestId('replace')).toHaveTextContent('Prefers short concise answers.')
    })

    test('short mode trims long unchanged runs to their ends', () => {
        const same = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
        render(<p data-testid="diff"><DiffText before={`${same} old ${same}`} after={`${same} new ${same}`} short /></p>)
        const text = screen.getByTestId('diff').textContent!
        expect(text).toContain('…')
        expect(text.length).toBeLessThan(same.length)
    })
})
