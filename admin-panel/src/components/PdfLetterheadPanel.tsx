import { useEffect, useMemo, useRef, useState } from 'react'
import { DefaultGraphResponse } from '../models/defaultGraph.models'
import {
    COMPANY_NAME_MAX,
    FOOTER_TEXT_MAX,
    LOGO_MEDIA_TYPES,
    PAGE_SIZES,
    PageSize,
    PdfLetterhead,
    letterheadProblem,
    logoFileProblem,
    readLetterhead,
    writeLetterhead,
} from '../lib/letterhead'
import { getLetterheadLogoUrl, uploadLetterheadLogo } from '../services/letterheadService'

interface Props {
    graph: DefaultGraphResponse
    getToken: () => Promise<string>
    /** Saves one node's whole config (the page reloads the graph afterwards). */
    onSaveNodeConfig: (nodeId: string, config: string) => Promise<void>
}

function enablesGeneratePdf(config: string): boolean {
    try {
        const tools = JSON.parse(config || '{}').tools
        return !Array.isArray(tools) || tools.includes('generate_pdf')
    } catch {
        return true
    }
}

/**
 * The letterhead generate_pdf puts on the PDFs this agent writes (plan 6.2):
 * company name, footer text, accent colour, default page size and a logo on
 * page 1. Stored on the agent's tool executor node as
 * config.tool_settings.generate_pdf. Typst renderer only.
 */
export default function PdfLetterheadPanel({ graph, getToken, onSaveNodeConfig }: Props) {
    const toolNodes = useMemo(
        () => graph.nodes.filter((node) => node.nodeType === 'TOOL_EXECUTOR'),
        [graph.nodes]
    )
    const [nodeId, setNodeId] = useState('')
    const node = toolNodes.find((n) => n.nodeId === nodeId) ?? toolNodes[0]

    // A ref, so a caller passing a fresh function each render cannot
    // re-trigger the preview fetch.
    const getTokenRef = useRef(getToken)
    getTokenRef.current = getToken

    const [form, setForm] = useState<PdfLetterhead>({})
    const [logoUrl, setLogoUrl] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

    // Re-read whenever another node is picked or the saved config changes.
    useEffect(() => {
        setForm(node ? readLetterhead(node.config) : {})
    }, [node?.nodeId, node?.config])

    const logoId = form.logo_attachment_id
    useEffect(() => {
        let cancelled = false
        setLogoUrl(null)
        if (!logoId) return
        ;(async () => {
            try {
                const url = await getLetterheadLogoUrl(await getTokenRef.current(), logoId)
                if (!cancelled) setLogoUrl(url)
            } catch {
                // The preview is optional; the id is still saved and used.
            }
        })()
        return () => {
            cancelled = true
        }
    }, [logoId])

    if (!graph.isSystem || !node) return null

    const update = (patch: PdfLetterhead) => {
        setMessage(null)
        setForm((current) => ({ ...current, ...patch }))
    }

    const handleLogo = async (file: File | undefined) => {
        if (!file) return
        const problem = logoFileProblem(file)
        if (problem) {
            setMessage({ kind: 'error', text: problem })
            return
        }
        setBusy(true)
        setMessage(null)
        try {
            const attachmentId = await uploadLetterheadLogo(await getToken(), file)
            update({ logo_attachment_id: attachmentId })
            setMessage({ kind: 'success', text: 'Logo uploaded. Save the letterhead to use it.' })
        } catch (e) {
            setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Uploading the logo failed' })
        } finally {
            setBusy(false)
        }
    }

    const handleSave = async () => {
        const problem = letterheadProblem(form)
        if (problem) {
            setMessage({ kind: 'error', text: problem })
            return
        }
        setBusy(true)
        setMessage(null)
        try {
            await onSaveNodeConfig(node.nodeId, writeLetterhead(node.config, form))
            setMessage({ kind: 'success', text: 'Letterhead saved.' })
        } catch (e) {
            setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Saving the letterhead failed' })
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className="form-card letterhead-panel" data-testid="pdf-letterhead">
            <div>
                <h3>PDF letterhead</h3>
                <p className="page-description">
                    Shown on every PDF this agent generates (Typst renderer). Saving reloads the
                    graph editor, so save graph edits first.
                </p>
            </div>
            {toolNodes.length > 1 && (
                <label className="config-field">
                    Tool executor node
                    <select value={node.nodeId} disabled={busy} onChange={(e) => setNodeId(e.target.value)}>
                        {toolNodes.map((n) => (
                            <option key={n.nodeId} value={n.nodeId}>
                                {n.name} ({n.nodeId})
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {!enablesGeneratePdf(node.config) && (
                <div className="row-message error">
                    This node does not enable generate_pdf, so the letterhead has no effect yet.
                </div>
            )}
            <div className="config-row">
                <label className="config-field grow">
                    Company name
                    <input
                        type="text"
                        maxLength={COMPANY_NAME_MAX}
                        placeholder="e.g. Acme GmbH"
                        value={form.company_name ?? ''}
                        disabled={busy}
                        onChange={(e) => update({ company_name: e.target.value })}
                    />
                </label>
                <label className="config-field grow">
                    Footer text
                    <input
                        type="text"
                        maxLength={FOOTER_TEXT_MAX}
                        placeholder="e.g. Confidential"
                        value={form.footer_text ?? ''}
                        disabled={busy}
                        onChange={(e) => update({ footer_text: e.target.value })}
                    />
                </label>
            </div>
            <div className="config-row">
                <label className="config-field">
                    Accent colour
                    <span className="letterhead-color">
                        <input
                            type="color"
                            aria-label="Pick accent colour"
                            value={form.accent_color && /^#[0-9A-Fa-f]{6}$/.test(form.accent_color)
                                ? form.accent_color.toLowerCase()
                                : '#1f4e79'}
                            disabled={busy}
                            onChange={(e) => update({ accent_color: e.target.value.toUpperCase() })}
                        />
                        <input
                            type="text"
                            placeholder="none"
                            value={form.accent_color ?? ''}
                            disabled={busy}
                            onChange={(e) => update({ accent_color: e.target.value.trim() })}
                        />
                    </span>
                </label>
                <label className="config-field">
                    Default page size
                    <select
                        value={form.default_page_size ?? ''}
                        disabled={busy}
                        onChange={(e) =>
                            update({ default_page_size: (e.target.value || undefined) as PageSize | undefined })
                        }
                    >
                        <option value="">Automatic (Letter in the US and Canada, A4 elsewhere)</option>
                        {PAGE_SIZES.map((size) => (
                            <option key={size} value={size}>
                                {size}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <div className="config-row letterhead-logo">
                <div className="config-field grow">
                    Logo (page 1; PNG or JPEG, at most 2 MB)
                    {logoId ? (
                        <span className="letterhead-logo-current">
                            {logoUrl ? <img src={logoUrl} alt="Current letterhead logo" /> : <code>{logoId}</code>}
                            <button type="button" disabled={busy} onClick={() => update({ logo_attachment_id: undefined })}>
                                Remove
                            </button>
                        </span>
                    ) : (
                        <span className="optional">No logo</span>
                    )}
                    <input
                        type="file"
                        accept={LOGO_MEDIA_TYPES.join(',')}
                        disabled={busy}
                        onChange={(e) => {
                            void handleLogo(e.target.files?.[0])
                            e.target.value = ''
                        }}
                    />
                </div>
            </div>
            <div className="form-actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void handleSave()}>
                    {busy ? 'Working…' : 'Save letterhead'}
                </button>
            </div>
            {message && <div className={`row-message ${message.kind}`}>{message.text}</div>}
        </section>
    )
}
