import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { OnboardingWizard } from '../../../components/onboarding/OnboardingWizard'

jest.mock('../../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}))

// Bare jest.fn()s here — resolved values are set in beforeEach via
// `.mockResolvedValue(...)` on the imported mock, NOT chained inline in this
// factory. Chaining here silently no-ops in this project's babel/CRA jest
// setup (the call returns undefined instead of the configured value).
jest.mock('../../../services/providerCatalogService', () => ({
    fetchProviderCatalog: jest.fn(),
    getCachedProviderCatalog: jest.fn(() => null),
    saveProviderCatalog: jest.fn(),
}))

jest.mock('../../../services/storeCustomerVendorApiKeysService', () => ({
    storeCustomerVendorApiKey: jest.fn(),
}))

jest.mock('../../../services/storeCustomerVectorDBConfigService', () => ({
    storeCustomerVectorDBConfig: jest.fn(),
}))

jest.mock('../../../services/embeddingKeysService', () => ({
    EmbeddingVendor: { OPENAI: 'OPENAI', VOYAGE: 'VOYAGE', HUGGINGFACE: 'HUGGINGFACE' },
    getEmbeddingKeys: jest.fn(),
    storeEmbeddingKey: jest.fn(),
}))

jest.mock('../../../services/customerToolsService', () => ({
    getToolCredentialStatuses: jest.fn(),
    storeToolCredentials: jest.fn(),
}))

import { useAuth } from '../../../context/AuthContext'
import { fetchProviderCatalog } from '../../../services/providerCatalogService'
import { withQueryClient } from '../../utils/queryWrapper'
import { storeCustomerVendorApiKey } from '../../../services/storeCustomerVendorApiKeysService'
import { storeCustomerVectorDBConfig } from '../../../services/storeCustomerVectorDBConfigService'
import { getEmbeddingKeys, storeEmbeddingKey } from '../../../services/embeddingKeysService'
import { getToolCredentialStatuses, storeToolCredentials } from '../../../services/customerToolsService'

const mockUseAuth = useAuth as jest.Mock
const VALID_ZILLIZ_ENDPOINT = 'https://in03-example.serverless.gcp-us-west1.cloud.zilliz.com'
const VALID_ZILLIZ_TOKEN = 'a'.repeat(64)

function baseAuth(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
    return {
        isAuthenticated: true,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
        aiVendorAPIKeyStatusList: [],
        vectorDBConfigStatusList: [],
        updateVendorApiKeyStatus: jest.fn(),
        updateVectorDBConfigStatus: jest.fn(),
        ...overrides,
    } as any
}

describe('OnboardingWizard', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockUseAuth.mockReturnValue(baseAuth())
        ;(fetchProviderCatalog as jest.Mock).mockResolvedValue({ providers: [] })
        ;(storeCustomerVendorApiKey as jest.Mock).mockResolvedValue({
            apiKeyStatus: { aiVendor: 'CLAUDE', isAPIKeyValid: true, status: 'API key is valid', updateSuccessful: true },
        })
        ;(storeCustomerVectorDBConfig as jest.Mock).mockResolvedValue({
            configStatus: { vendor: 'Zilliz', isConfigValid: true, status: 'PRESENT', updateSuccessful: true },
        })
        ;(getEmbeddingKeys as jest.Mock).mockResolvedValue({ statuses: [] })
        ;(storeEmbeddingKey as jest.Mock).mockResolvedValue({
            keyStatus: { vendor: 'VOYAGE', isAPIKeyValid: true, status: 'API key is valid', updateSuccessful: true },
        })
        ;(getToolCredentialStatuses as jest.Mock).mockResolvedValue({ toolCredentialStatuses: [] })
        ;(storeToolCredentials as jest.Mock).mockResolvedValue({
            toolCredentialStatus: { toolType: 'WEB_SEARCH', authType: 'api_key', connected: true },
        })
    })

    test('starts on the LLM step and shows progress 1 of 4', () => {
        render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))
        expect(screen.getByTestId('onboarding-progress')).toHaveTextContent('Step 1 of 4')
        expect(screen.getByTestId('onboarding-llm-vendor-select')).toBeInTheDocument()
        expect(screen.queryByTestId('onboarding-back')).not.toBeInTheDocument()
    })

    test('"Skip setup" finishes the wizard immediately from step 1', async () => {
        const onDone = jest.fn().mockResolvedValue(undefined)
        render(withQueryClient(<OnboardingWizard onDone={onDone} />))

        fireEvent.click(screen.getByTestId('onboarding-skip-all'))

        await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    })

    test('shows an inline error and stays open if finishing the wizard fails', async () => {
        const onDone = jest.fn().mockRejectedValue(new Error('network down'))
        render(withQueryClient(<OnboardingWizard onDone={onDone} />))

        fireEvent.click(screen.getByTestId('onboarding-skip-all'))

        await waitFor(() => expect(screen.getByTestId('onboarding-complete-error')).toBeInTheDocument())
        expect(screen.getByTestId('onboarding-wizard')).toBeInTheDocument()
    })

    test('"Skip this step" advances through all 4 steps without saving anything, then finishes on the last', async () => {
        const onDone = jest.fn().mockResolvedValue(undefined)
        render(withQueryClient(<OnboardingWizard onDone={onDone} />))

        expect(screen.getByTestId('onboarding-llm-vendor-select')).toBeInTheDocument()
        fireEvent.click(screen.getByTestId('onboarding-skip-step'))

        expect(await screen.findByTestId('onboarding-zilliz-endpoint-input')).toBeInTheDocument()
        expect(screen.getByTestId('onboarding-progress')).toHaveTextContent('Step 2 of 4')
        fireEvent.click(screen.getByTestId('onboarding-skip-step'))

        expect(await screen.findByTestId('onboarding-voyage-key-input')).toBeInTheDocument()
        fireEvent.click(screen.getByTestId('onboarding-skip-step'))

        expect(await screen.findByTestId('onboarding-tavily-key-input')).toBeInTheDocument()
        expect(screen.getByTestId('onboarding-progress')).toHaveTextContent('Step 4 of 4')
        expect(screen.getByTestId('onboarding-continue')).toHaveTextContent('Finish setup')

        fireEvent.click(screen.getByTestId('onboarding-skip-step'))

        await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    })

    test('"Back" returns to the previous step', async () => {
        render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))

        fireEvent.click(screen.getByTestId('onboarding-skip-step'))
        expect(await screen.findByTestId('onboarding-zilliz-endpoint-input')).toBeInTheDocument()

        fireEvent.click(screen.getByTestId('onboarding-back'))
        expect(await screen.findByTestId('onboarding-llm-vendor-select')).toBeInTheDocument()
        expect(screen.queryByTestId('onboarding-back')).not.toBeInTheDocument()
    })

    test('LLM step shows "already configured" when a vendor key is already valid', () => {
        mockUseAuth.mockReturnValue(baseAuth({
            aiVendorAPIKeyStatusList: [
                { aiVendor: 'CLAUDE', isAPIKeyValid: true, status: 'API key is valid', updateSuccessful: true },
            ],
        }))
        render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))
        expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('Already set up')
    })

    test('Continue is disabled on the LLM step once a key is entered without picking a vendor', () => {
        render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))

        expect(screen.getByTestId('onboarding-continue')).not.toBeDisabled()
        fireEvent.change(screen.getByTestId('onboarding-llm-key-input'), { target: { value: 'sk-test-key' } })
        expect(screen.getByTestId('onboarding-continue')).toBeDisabled()

        fireEvent.change(screen.getByTestId('onboarding-llm-vendor-select'), { target: { value: 'CLAUDE' } })
        expect(screen.getByTestId('onboarding-continue')).not.toBeDisabled()
    })

    test('LLM step saves a valid key and vendor, then advances to Zilliz', async () => {
        const updateVendorApiKeyStatus = jest.fn()
        mockUseAuth.mockReturnValue(baseAuth({ updateVendorApiKeyStatus }))
        render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))

        fireEvent.change(screen.getByTestId('onboarding-llm-vendor-select'), { target: { value: 'CLAUDE' } })
        fireEvent.change(screen.getByTestId('onboarding-llm-key-input'), { target: { value: 'sk-test-key' } })
        fireEvent.click(screen.getByTestId('onboarding-continue'))

        expect(await screen.findByTestId('onboarding-zilliz-endpoint-input')).toBeInTheDocument()
        expect(storeCustomerVendorApiKey).toHaveBeenCalledWith('token', { aiVendor: 'CLAUDE', apiKey: 'sk-test-key' })
        expect(updateVendorApiKeyStatus).toHaveBeenCalled()
    })

    test('LLM step shows the vendor rejection message and stays on step 1', async () => {
        ;(storeCustomerVendorApiKey as jest.Mock).mockResolvedValueOnce({
            apiKeyStatus: { aiVendor: 'CLAUDE', isAPIKeyValid: false, status: 'API key is not valid', updateSuccessful: false, detail: 'invalid key' },
        })
        render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))

        fireEvent.change(screen.getByTestId('onboarding-llm-vendor-select'), { target: { value: 'CLAUDE' } })
        fireEvent.change(screen.getByTestId('onboarding-llm-key-input'), { target: { value: 'sk-bad-key' } })
        fireEvent.click(screen.getByTestId('onboarding-continue'))

        await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('invalid key'))
        expect(screen.getByTestId('onboarding-llm-vendor-select')).toBeInTheDocument()
    })

    test('LLM step shows a generic error when the save call throws', async () => {
        ;(storeCustomerVendorApiKey as jest.Mock).mockRejectedValueOnce(new Error('boom'))
        render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))

        fireEvent.change(screen.getByTestId('onboarding-llm-vendor-select'), { target: { value: 'CLAUDE' } })
        fireEvent.change(screen.getByTestId('onboarding-llm-key-input'), { target: { value: 'sk-bad-key' } })
        fireEvent.click(screen.getByTestId('onboarding-continue'))

        await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('boom'))
    })

    describe('Zilliz step', () => {
        async function goToZillizStep() {
            render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))
            fireEvent.click(screen.getByTestId('onboarding-skip-step'))
            await screen.findByTestId('onboarding-zilliz-endpoint-input')
        }

        test('shows "already configured" when Zilliz is already PRESENT', async () => {
            mockUseAuth.mockReturnValue(baseAuth({
                vectorDBConfigStatusList: [{ vendor: 'Zilliz', isConfigValid: true, status: 'PRESENT', updateSuccessful: true }],
            }))
            await goToZillizStep()
            expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('Already set up')
        })

        test('rejects an invalid endpoint without calling the save endpoint', async () => {
            await goToZillizStep()
            fireEvent.change(screen.getByTestId('onboarding-zilliz-endpoint-input'), { target: { value: 'not-a-url' } })
            fireEvent.change(screen.getByTestId('onboarding-zilliz-token-input'), { target: { value: VALID_ZILLIZ_TOKEN } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('Zilliz Cloud endpoint'))
            expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled()
        })

        test('rejects an invalid token without calling the save endpoint', async () => {
            await goToZillizStep()
            fireEvent.change(screen.getByTestId('onboarding-zilliz-endpoint-input'), { target: { value: VALID_ZILLIZ_ENDPOINT } })
            fireEvent.change(screen.getByTestId('onboarding-zilliz-token-input'), { target: { value: 'short' } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('Zilliz Cloud token'))
            expect(storeCustomerVectorDBConfig).not.toHaveBeenCalled()
        })

        test('saves a valid endpoint and token, then advances to Voyage', async () => {
            const updateVectorDBConfigStatus = jest.fn()
            mockUseAuth.mockReturnValue(baseAuth({ updateVectorDBConfigStatus }))
            await goToZillizStep()

            fireEvent.change(screen.getByTestId('onboarding-zilliz-endpoint-input'), { target: { value: VALID_ZILLIZ_ENDPOINT } })
            fireEvent.change(screen.getByTestId('onboarding-zilliz-token-input'), { target: { value: VALID_ZILLIZ_TOKEN } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            expect(await screen.findByTestId('onboarding-voyage-key-input')).toBeInTheDocument()
            expect(storeCustomerVectorDBConfig).toHaveBeenCalledWith('token', {
                vendor: 'Zilliz', endpoint: VALID_ZILLIZ_ENDPOINT, token: VALID_ZILLIZ_TOKEN,
            })
            expect(updateVectorDBConfigStatus).toHaveBeenCalled()
        })

        test('shows a generic error when the server reports the update failed', async () => {
            ;(storeCustomerVectorDBConfig as jest.Mock).mockResolvedValueOnce({
                configStatus: { vendor: 'Zilliz', isConfigValid: false, status: 'NOT_SET', updateSuccessful: false },
            })
            await goToZillizStep()

            fireEvent.change(screen.getByTestId('onboarding-zilliz-endpoint-input'), { target: { value: VALID_ZILLIZ_ENDPOINT } })
            fireEvent.change(screen.getByTestId('onboarding-zilliz-token-input'), { target: { value: VALID_ZILLIZ_TOKEN } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toBeInTheDocument())
            expect(screen.getByTestId('onboarding-zilliz-endpoint-input')).toBeInTheDocument()
        })
    })

    describe('Voyage step', () => {
        async function goToVoyageStep() {
            render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))
            fireEvent.click(screen.getByTestId('onboarding-skip-step'))
            await screen.findByTestId('onboarding-zilliz-endpoint-input')
            fireEvent.click(screen.getByTestId('onboarding-skip-step'))
            await screen.findByTestId('onboarding-voyage-key-input')
        }

        test('shows "already configured" once the embedding-keys status resolves VALID', async () => {
            ;(getEmbeddingKeys as jest.Mock).mockResolvedValueOnce({
                statuses: [{ vendor: 'VOYAGE', isAPIKeyValid: true, status: 'API key is valid' }],
            })
            await goToVoyageStep()
            await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('Already set up'))
        })

        test('saves a key and advances to Tavily', async () => {
            await goToVoyageStep()
            fireEvent.change(screen.getByTestId('onboarding-voyage-key-input'), { target: { value: 'pa-voyage-key' } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            expect(await screen.findByTestId('onboarding-tavily-key-input')).toBeInTheDocument()
            expect(storeEmbeddingKey).toHaveBeenCalledWith('token', 'VOYAGE', 'pa-voyage-key')
        })

        test('shows the rejection detail when the vendor rejects the key', async () => {
            ;(storeEmbeddingKey as jest.Mock).mockResolvedValueOnce({
                keyStatus: { vendor: 'VOYAGE', isAPIKeyValid: false, status: 'API key is not valid', updateSuccessful: false, detail: 'voyage says no' },
            })
            await goToVoyageStep()
            fireEvent.change(screen.getByTestId('onboarding-voyage-key-input'), { target: { value: 'pa-bad-key' } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('voyage says no'))
        })

        test('renders the optional Hugging Face token field', async () => {
            await goToVoyageStep()
            expect(screen.getByTestId('onboarding-hf-token-input')).toBeInTheDocument()
        })

        test('continuing with both fields empty advances without saving anything', async () => {
            await goToVoyageStep()
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            expect(await screen.findByTestId('onboarding-tavily-key-input')).toBeInTheDocument()
            expect(storeEmbeddingKey).not.toHaveBeenCalled()
        })

        test('saves only the Hugging Face token when the Voyage key is left empty', async () => {
            ;(storeEmbeddingKey as jest.Mock).mockResolvedValueOnce({
                keyStatus: { vendor: 'HUGGINGFACE', isAPIKeyValid: true, status: 'API key is valid', updateSuccessful: true },
            })
            await goToVoyageStep()
            fireEvent.change(screen.getByTestId('onboarding-hf-token-input'), { target: { value: 'hf_token' } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            expect(await screen.findByTestId('onboarding-tavily-key-input')).toBeInTheDocument()
            expect(storeEmbeddingKey).toHaveBeenCalledTimes(1)
            expect(storeEmbeddingKey).toHaveBeenCalledWith('token', 'HUGGINGFACE', 'hf_token')
        })

        test('saves both the Voyage key and the Hugging Face token when both are entered', async () => {
            await goToVoyageStep()
            fireEvent.change(screen.getByTestId('onboarding-voyage-key-input'), { target: { value: 'pa-voyage-key' } })
            fireEvent.change(screen.getByTestId('onboarding-hf-token-input'), { target: { value: 'hf_token' } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            expect(await screen.findByTestId('onboarding-tavily-key-input')).toBeInTheDocument()
            expect(storeEmbeddingKey).toHaveBeenCalledWith('token', 'VOYAGE', 'pa-voyage-key')
            expect(storeEmbeddingKey).toHaveBeenCalledWith('token', 'HUGGINGFACE', 'hf_token')
        })

        test('shows the error and stays when the Hugging Face token save fails', async () => {
            ;(storeEmbeddingKey as jest.Mock).mockResolvedValueOnce({
                keyStatus: { vendor: 'HUGGINGFACE', isAPIKeyValid: false, status: 'API key is not valid', updateSuccessful: false, detail: 'hub says no' },
            })
            await goToVoyageStep()
            fireEvent.change(screen.getByTestId('onboarding-hf-token-input'), { target: { value: 'hf_bad' } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('hub says no'))
            expect(screen.getByTestId('onboarding-hf-token-input')).toBeInTheDocument()
        })
    })

    describe('Tavily step', () => {
        async function goToTavilyStep() {
            render(withQueryClient(<OnboardingWizard onDone={jest.fn()} />))
            fireEvent.click(screen.getByTestId('onboarding-skip-step'))
            await screen.findByTestId('onboarding-zilliz-endpoint-input')
            fireEvent.click(screen.getByTestId('onboarding-skip-step'))
            await screen.findByTestId('onboarding-voyage-key-input')
            fireEvent.click(screen.getByTestId('onboarding-skip-step'))
            await screen.findByTestId('onboarding-tavily-key-input')
        }

        test('shows "already configured" once WEB_SEARCH is connected', async () => {
            ;(getToolCredentialStatuses as jest.Mock).mockResolvedValueOnce({
                toolCredentialStatuses: [{ toolType: 'WEB_SEARCH', authType: 'api_key', connected: true }],
            })
            await goToTavilyStep()
            await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('Already set up'))
        })

        test('saves a key and finishes the wizard', async () => {
            const onDone = jest.fn().mockResolvedValue(undefined)
            render(withQueryClient(<OnboardingWizard onDone={onDone} />))
            fireEvent.click(screen.getByTestId('onboarding-skip-step'))
            await screen.findByTestId('onboarding-zilliz-endpoint-input')
            fireEvent.click(screen.getByTestId('onboarding-skip-step'))
            await screen.findByTestId('onboarding-voyage-key-input')
            fireEvent.click(screen.getByTestId('onboarding-skip-step'))
            await screen.findByTestId('onboarding-tavily-key-input')

            fireEvent.change(screen.getByTestId('onboarding-tavily-key-input'), { target: { value: 'tvly-key' } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
            expect(storeToolCredentials).toHaveBeenCalledWith('token', {
                toolType: 'WEB_SEARCH', authType: 'api_key', credentials: { api_key: 'tvly-key' },
            })
        })

        test('shows a generic error when the save call throws', async () => {
            ;(storeToolCredentials as jest.Mock).mockRejectedValueOnce(new Error('tavily down'))
            await goToTavilyStep()
            fireEvent.change(screen.getByTestId('onboarding-tavily-key-input'), { target: { value: 'tvly-key' } })
            fireEvent.click(screen.getByTestId('onboarding-continue'))

            await waitFor(() => expect(screen.getByTestId('onboarding-step-message')).toHaveTextContent('tavily down'))
        })
    })
})
