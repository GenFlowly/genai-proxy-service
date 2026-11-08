import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { AiDataConsentScreen } from '../../../components/onboarding/AiDataConsentScreen'
import translation from '../../../i18n/locales/en/translation.json'

describe('AiDataConsentScreen', () => {
    it('says who receives the data, without naming a vendor', () => {
        render(<AiDataConsentScreen onAgree={jest.fn()} onDecline={jest.fn()} />)

        expect(screen.getByText('AI model providers')).toBeInTheDocument()
        expect(screen.getByText('Memory and search')).toBeInTheDocument()
        expect(screen.getByText('Web search and connected tools')).toBeInTheDocument()
        expect(JSON.stringify(translation.aiDataConsent)).not.toMatch(
            /openai|anthropic|claude|gemini|google|xai|grok|voyage|zilliz|milvus|tavily/i
        )
    })

    it('links to the privacy policy in a new tab', () => {
        render(<AiDataConsentScreen onAgree={jest.fn()} onDecline={jest.fn()} />)

        const link = screen.getByTestId('ai-data-consent-policy')
        expect(link).toHaveAttribute('href', '/privacy-policy')
        expect(link).toHaveAttribute('target', '_blank')
    })

    it('agrees through onAgree and blocks a second tap while saving', async () => {
        let finish: () => void = () => undefined
        const onAgree = jest.fn(() => new Promise<void>(resolve => { finish = resolve }))
        render(<AiDataConsentScreen onAgree={onAgree} onDecline={jest.fn()} />)

        fireEvent.click(screen.getByTestId('ai-data-consent-agree'))

        expect(onAgree).toHaveBeenCalledTimes(1)
        await waitFor(() => expect(screen.getByTestId('ai-data-consent-agree')).toBeDisabled())
        expect(screen.getByTestId('ai-data-consent-decline')).toBeDisabled()
        finish()
    })

    it('shows an error and lets the customer retry when saving fails', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => undefined)
        const onAgree = jest.fn().mockRejectedValue(new Error('down'))
        render(<AiDataConsentScreen onAgree={onAgree} onDecline={jest.fn()} />)

        fireEvent.click(screen.getByTestId('ai-data-consent-agree'))

        expect(await screen.findByTestId('ai-data-consent-error')).toBeInTheDocument()
        expect(screen.getByTestId('ai-data-consent-agree')).toBeEnabled()
        ;(console.error as jest.Mock).mockRestore()
    })

    it('declines through onDecline', () => {
        const onDecline = jest.fn()
        render(<AiDataConsentScreen onAgree={jest.fn()} onDecline={onDecline} />)

        fireEvent.click(screen.getByTestId('ai-data-consent-decline'))

        expect(onDecline).toHaveBeenCalledTimes(1)
    })
})
