import React from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import NotesHeader from '../../../../components/widgets/NotesHeader/NotesHeader'

describe('NotesHeader', () => {
    test('renders the Memory title without any context providers', () => {
        render(<NotesHeader />)

        expect(screen.getByTestId('notes-header')).toBeInTheDocument()
        expect(screen.getByText('Memory')).toBeInTheDocument()
    })
})
