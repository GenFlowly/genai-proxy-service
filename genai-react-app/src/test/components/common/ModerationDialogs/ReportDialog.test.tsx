import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReportDialog } from '../../../../components/common/ModerationDialogs/ReportDialog'
import { reportContent } from '../../../../services/moderationService'

jest.mock('../../../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('token') }),
}))
jest.mock('../../../../services/moderationService', () => ({
    ...jest.requireActual('../../../../services/moderationService'),
    reportContent: jest.fn(),
}))
const mockBreakpoints = jest.fn()
jest.mock('../../../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: () => mockBreakpoints() }))

const mockReport = reportContent as jest.Mock

function setup(overrides: Partial<React.ComponentProps<typeof ReportDialog>> = {}) {
    const props = {
        isOpen: true,
        onClose: jest.fn(),
        entityType: 'CONVERSATION' as const,
        entityId: 'conv-1',
        ownerLabel: '@mara',
        canBlock: true,
        canRemove: true,
        onBlock: jest.fn(),
        blocking: false,
        blockError: null,
        onRemove: jest.fn(),
        ...overrides,
    }
    render(<ReportDialog {...props} />)
    return props
}

describe('ReportDialog', () => {
    beforeEach(() => {
        mockBreakpoints.mockReturnValue({ isNarrow: false })
        mockReport.mockReset()
        mockReport.mockResolvedValue(undefined)
    })

    test('renders nothing when closed', () => {
        setup({ isOpen: false })
        expect(screen.queryByTestId('report-form')).not.toBeInTheDocument()
    })

    test('needs a reason before it can be sent', () => {
        setup()
        expect(screen.getByTestId('report-send')).toBeDisabled()
        fireEvent.click(screen.getByTestId('report-reason-HATE'))
        expect(screen.getByTestId('report-send')).toBeEnabled()
    })

    test('sends the reason and trimmed details, then offers Block and Remove', async () => {
        const props = setup()
        fireEvent.click(screen.getByTestId('report-reason-HARASSMENT'))
        fireEvent.change(screen.getByTestId('report-details'), { target: { value: '  rude  ' } })
        fireEvent.click(screen.getByTestId('report-send'))

        await screen.findByTestId('report-sent')
        expect(mockReport).toHaveBeenCalledWith('token', { entityType: 'CONVERSATION', entityId: 'conv-1', reason: 'HARASSMENT', details: 'rude' })

        fireEvent.click(screen.getByTestId('report-block'))
        expect(props.onBlock).toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('report-remove'))
        expect(props.onRemove).toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('report-done'))
        expect(props.onClose).toHaveBeenCalled()
    })

    test('leaves out details when none were written', async () => {
        setup()
        fireEvent.click(screen.getByTestId('report-reason-SPAM'))
        fireEvent.click(screen.getByTestId('report-send'))
        await screen.findByTestId('report-sent')
        expect(mockReport).toHaveBeenCalledWith('token', { entityType: 'CONVERSATION', entityId: 'conv-1', reason: 'SPAM' })
    })

    test('hides Block and Remove when they do not apply', async () => {
        setup({ canBlock: false, canRemove: false, entityType: 'INSTRUCTION' })
        fireEvent.click(screen.getByTestId('report-reason-SPAM'))
        fireEvent.click(screen.getByTestId('report-send'))
        await screen.findByTestId('report-sent')
        expect(screen.queryByTestId('report-block')).not.toBeInTheDocument()
        expect(screen.queryByTestId('report-remove')).not.toBeInTheDocument()
    })

    test('shows a failure and keeps the form', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined)
        mockReport.mockRejectedValue(new Error('nope'))
        setup()
        fireEvent.click(screen.getByTestId('report-reason-SPAM'))
        fireEvent.click(screen.getByTestId('report-send'))
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
        expect(screen.getByTestId('report-form')).toBeInTheDocument()
    })

    test('the details box is limited to 1,000 characters and links the content rules', () => {
        setup()
        expect(screen.getByTestId('report-details')).toHaveAttribute('maxlength', '1000')
        expect(screen.getByRole('link', { name: 'Content rules' })).toHaveAttribute('href', '/content-rules')
    })

    test('is a bottom sheet on phones, and tapping outside closes it', () => {
        mockBreakpoints.mockReturnValue({ isNarrow: true })
        const props = setup()
        const sheet = screen.getByTestId('report-sheet')
        expect(screen.getByRole('dialog')).toHaveAccessibleName('Report this conversation')
        fireEvent.click(screen.getByRole('dialog'))
        expect(props.onClose).not.toHaveBeenCalled()
        fireEvent.click(sheet)
        expect(props.onClose).toHaveBeenCalled()
    })

    test('shows a block error on the confirmation', async () => {
        const { rerender } = render(
            <ReportDialog isOpen onClose={jest.fn()} entityType="CONVERSATION" entityId="c" ownerLabel="@m" canBlock canRemove onBlock={jest.fn()} blocking={false} blockError={null} onRemove={jest.fn()} />
        )
        fireEvent.click(screen.getByTestId('report-reason-SPAM'))
        fireEvent.click(screen.getByTestId('report-send'))
        await screen.findByTestId('report-sent')
        rerender(<ReportDialog isOpen onClose={jest.fn()} entityType="CONVERSATION" entityId="c" ownerLabel="@m" canBlock canRemove onBlock={jest.fn()} blocking blockError="failed" onRemove={jest.fn()} />)
        expect(screen.getByRole('alert')).toHaveTextContent('failed')
        expect(screen.getByTestId('report-block')).toBeDisabled()
    })
})
