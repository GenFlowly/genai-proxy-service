import { useCallback, useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { useNavigate, useParams } from 'react-router-dom'
import { InstructionEditor } from '@genflowly/component-library'
import {
    createInstruction,
    deleteInstruction,
    getCustomerInstructions,
    shareInstructionPublic,
} from '../services/instructionsService'
import { InstructionResponse } from '../models/instructions.models'

export default function InstructionDetailPage() {
    const { getAccessTokenSilently } = useAuth0()
    const navigate = useNavigate()
    const { instructionId } = useParams<{ instructionId: string }>()
    const isNew = instructionId === 'new'

    const [name, setName] = useState('')
    const [instruction, setInstruction] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Version history of the loaded instruction, newest first
    const [versions, setVersions] = useState<InstructionResponse[]>([])
    const [versionsLoading, setVersionsLoading] = useState(false)
    const [versionsError, setVersionsError] = useState(false)
    const [selectedVersion, setSelectedVersion] = useState<number | null>(null)

    const loadVersions = useCallback(async (id: string) => {
        setVersionsLoading(true)
        setVersionsError(false)
        try {
            const token = await getAccessTokenSilently()
            const response = await getCustomerInstructions(token)
            const history = response.instructions
                .filter((i) => i.id === id)
                .sort((a, b) => b.version - a.version)
            setVersions(history)
            return history
        } catch {
            setVersionsError(true)
            return []
        } finally {
            setVersionsLoading(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Load the instruction (latest version) when the route changes
    useEffect(() => {
        setSelectedVersion(null)
        setError(null)
        if (isNew || !instructionId) {
            setName('')
            setInstruction('')
            setVersions([])
            return
        }
        void loadVersions(instructionId).then((history) => {
            const latest = history[0]
            if (latest) {
                setName(latest.name ?? '')
                setInstruction(latest.instruction)
            }
        })
    }, [instructionId, isNew, loadVersions])

    const currentVersion =
        (selectedVersion !== null
            ? versions.find((v) => v.version === selectedVersion)
            : undefined) ?? versions[0]

    const handleSelectVersion = (version: number) => {
        const match = versions.find((v) => v.version === version)
        if (!match) return
        setSelectedVersion(version)
        setName(match.name ?? '')
        setInstruction(match.instruction)
    }

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
                existingInstructionId: isNew ? undefined : instructionId,
            })
            // Public by default: share the new instruction with "PUBLIC"
            await shareInstructionPublic(token, response.id)
            setSelectedVersion(null)
            if (isNew || response.id !== instructionId) {
                navigate(`/instructions/${response.id}`, { replace: true })
            } else {
                void loadVersions(response.id)
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save instruction')
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async () => {
        if (!instructionId || isNew) return
        if (!window.confirm('Delete this instruction and all its versions? This cannot be undone.')) return
        setSaving(true)
        setError(null)
        try {
            const token = await getAccessTokenSilently()
            await deleteInstruction(token, instructionId)
            navigate('/instructions')
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to delete instruction')
            setSaving(false)
        }
    }

    return (
        <section className="page">
            <div className="page-title-row">
                <h2>{isNew ? 'New public instruction' : currentVersion?.name || 'Edit public instruction'}</h2>
                <button onClick={() => navigate('/instructions')}>← All instructions</button>
            </div>

            {error && <div className="banner error">{error}</div>}

            <div className="instruction-editor-container">
                <InstructionEditor
                    name={name}
                    onNameChange={setName}
                    instructionText={instruction}
                    onInstructionTextChange={setInstruction}
                    isNew={isNew}
                    isLoading={saving}
                    canDelete={currentVersion?.role === 'OWNER'}
                    onSave={() => void handleSave()}
                    onDelete={() => void handleDelete()}
                    editorId="admin-instruction-editor"
                    versions={versions.map((v) => ({
                        version: v.version,
                        details: v.name || undefined,
                    }))}
                    selectedVersion={selectedVersion ?? versions[0]?.version}
                    onSelectVersion={handleSelectVersion}
                    versionsLoading={versionsLoading}
                    versionsError={versionsError}
                    icon={currentVersion?.icon || undefined}
                    color={currentVersion?.color || undefined}
                    role={currentVersion?.role}
                    category={currentVersion?.category || undefined}
                    tags={currentVersion?.tags || undefined}
                    labels={{
                        save: isNew ? 'Save as public instruction' : 'Save new version',
                        namePlaceholder: 'e.g. Marketing copy editor',
                    }}
                />
            </div>
        </section>
    )
}
