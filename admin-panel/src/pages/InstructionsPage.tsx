import { useEffect, useMemo, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { useNavigate } from 'react-router-dom'
import { InstructionTile } from '@genflowly/component-library'
import { getCustomerInstructions } from '../services/instructionsService'
import { InstructionResponse } from '../models/instructions.models'

export default function InstructionsPage() {
    const { getAccessTokenSilently, user } = useAuth0()
    const navigate = useNavigate()
    const [instructions, setInstructions] = useState<InstructionResponse[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                const token = await getAccessTokenSilently()
                const response = await getCustomerInstructions(token)
                if (!cancelled) setInstructions(response.instructions)
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load instructions')
            } finally {
                if (!cancelled) setIsLoading(false)
            }
        })()
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Latest version of each instruction this account owns
    const ownInstructions = useMemo(() => {
        const latest = new Map<string, InstructionResponse>()
        instructions
            .filter((i) => i.role === 'OWNER')
            .forEach((i) => {
                const existing = latest.get(i.id)
                if (!existing || i.version > existing.version) latest.set(i.id, i)
            })
        return Array.from(latest.values())
    }, [instructions])

    return (
        <section className="page">
            <div className="page-title-row">
                <h2>Instructions</h2>
                <button className="primary" onClick={() => navigate('/instructions/new')}>
                    + New instruction
                </button>
            </div>

            {error && <div className="banner error">{error}</div>}

            {isLoading ? (
                <p className="page-description">Loading…</p>
            ) : ownInstructions.length === 0 ? (
                <p className="page-description">No instructions yet. Create one to get started.</p>
            ) : (
                <div className="tile-grid">
                    {ownInstructions.map((instruction) => (
                        <InstructionTile
                            key={instruction.id}
                            title={instruction.name || 'Untitled instruction'}
                            detail={instruction.instruction}
                            icon={instruction.icon || undefined}
                            color={instruction.color || undefined}
                            tags={instruction.tags || undefined}
                            version={instruction.version}
                            owner={user?.name ? { name: user.name, avatarUrl: user.picture } : undefined}
                            onClick={() => navigate(`/instructions/${instruction.id}`)}
                            data-testid={`instruction-tile-${instruction.id}`}
                        />
                    ))}
                </div>
            )}
        </section>
    )
}
