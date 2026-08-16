import { useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { createInstruction, shareInstructionPublic } from '../services/instructionsService'
import { InstructionResponse } from '../models/instructions.models'

export default function InstructionsPage() {
    const { getAccessTokenSilently } = useAuth0()
    const [name, setName] = useState('')
    const [instruction, setInstruction] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [created, setCreated] = useState<InstructionResponse[]>([])

    const handleSave = async () => {
        const trimmed = instruction.trim()
        if (!trimmed) {
            setError('Instruction text is required')
            return
        }
        setSaving(true)
        setError(null)
        try {
            const token = await getAccessTokenSilently()
            const response = await createInstruction(token, {
                instruction: trimmed,
                instructionName: name.trim() || undefined,
            })
            // Public by default: share the new instruction with "PUBLIC"
            await shareInstructionPublic(token, response.id)
            setCreated((prev) => [response, ...prev])
            setName('')
            setInstruction('')
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save instruction')
        } finally {
            setSaving(false)
        }
    }

    return (
        <section className="page">
            <h2>Instructions</h2>
            <p className="page-description">
                Create instructions (personas). Instructions saved here are made{' '}
                <strong>public</strong> automatically — visible to all users.
            </p>

            {error && <div className="banner error">{error}</div>}

            <div className="form-card">
                <label>
                    Name <span className="optional">(optional)</span>
                    <input
                        type="text"
                        placeholder="e.g. Marketing copy editor"
                        value={name}
                        disabled={saving}
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>
                <label>
                    Instruction
                    <textarea
                        placeholder="You are a helpful assistant that…"
                        rows={10}
                        value={instruction}
                        disabled={saving}
                        onChange={(e) => setInstruction(e.target.value)}
                    />
                </label>
                <div className="form-actions">
                    <button
                        className="primary"
                        disabled={saving || !instruction.trim()}
                        onClick={() => void handleSave()}
                    >
                        {saving ? 'Saving…' : 'Save as public instruction'}
                    </button>
                </div>
            </div>

            {created.length > 0 && (
                <div className="created-list">
                    <h3>Created this session</h3>
                    {created.map((item) => (
                        <div className="created-item" key={`${item.id}-${item.version}`}>
                            <div>
                                <strong>{item.name}</strong>
                                <span className="created-meta">
                                    {item.id} · v{item.version} · public
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    )
}
