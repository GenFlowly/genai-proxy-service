import { chosenEmbeddingModel, embeddingVendorFor, isEmbeddingModelUnusable } from '../../utils/embeddingModel'
import { EmbeddingVendor } from '../../services/embeddingKeysService'

describe('embeddingModel helpers', () => {
    test('the chosen model reads conversations, then the single field, then notes, ignoring blanks', () => {
        expect(chosenEmbeddingModel(null)).toBeNull()
        expect(chosenEmbeddingModel({ embeddingModelConversations: ' ', embeddingModel: 'voyage-4-large' })).toBe('voyage-4-large')
        expect(chosenEmbeddingModel({ embeddingModelNotes: 'text-embedding-3-small' })).toBe('text-embedding-3-small')
        expect(chosenEmbeddingModel({ embeddingModelConversations: 'a', embeddingModel: 'b' })).toBe('a')
    })

    test('the vendor follows the naming convention', () => {
        expect(embeddingVendorFor('voyage-4-large')).toBe(EmbeddingVendor.VOYAGE)
        expect(embeddingVendorFor('text-embedding-3-large')).toBe(EmbeddingVendor.OPENAI)
        expect(embeddingVendorFor('mystery')).toBeNull()
        expect(embeddingVendorFor(null)).toBeNull()
    })

    test('a model is unusable only when its working vendor no longer lists it, or no vendor owns it', () => {
        const list = [{ vendor: EmbeddingVendor.OPENAI, models: ['text-embedding-3-large'] }]
        expect(isEmbeddingModelUnusable('text-embedding-3-large', list)).toBe(false)
        expect(isEmbeddingModelUnusable('text-embedding-ada-002', list)).toBe(true)
        expect(isEmbeddingModelUnusable('voyage-multimodal-3.5', list)).toBe(false)
        expect(isEmbeddingModelUnusable('mystery', list)).toBe(true)
    })
})
