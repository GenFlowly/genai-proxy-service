import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import {
    VendorAllowlistEntry,
    getVendorAllowlist,
    putVendorAllowlist,
} from '../services/vendorAllowlistService'

/**
 * Which AI vendors customers can see in the react-app (Model API Keys
 * dropdown, key cards, sidebar model picker). Unchecked vendors disappear
 * for users; their stored keys are kept and come back if re-allowed.
 * Never-configured or fully-unchecked = every vendor visible, so a slip of
 * the mouse can't lock all customers out of AI.
 */
export default function VendorAllowlistPage() {
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [vendors, setVendors] = useState<VendorAllowlistEntry[]>([])
    const [checked, setChecked] = useState<Set<string>>(new Set())
    const [configured, setConfigured] = useState(false)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState<string | null>(null)
    const [messageKind, setMessageKind] = useState<'success' | 'error'>('success')
    const [filter, setFilter] = useState('')

    const refresh = useCallback(async () => {
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            const response = await getVendorAllowlist(token)
            setVendors(response.vendors)
            setConfigured(response.configured)
            setChecked(new Set(response.vendors.filter((v) => v.allowed).map((v) => v.id)))
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Failed to load vendor allowlist')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const toggle = (id: string) => {
        setMessage(null)
        setChecked((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const setAll = (allowed: boolean) => {
        setMessage(null)
        setChecked(allowed ? new Set(vendors.map((v) => v.id)) : new Set())
    }

    const handleSave = async () => {
        setSaving(true)
        setMessage(null)
        try {
            const token = await getAccessTokenSilently()
            await putVendorAllowlist(token, [...checked])
            setMessageKind('success')
            setMessage(
                checked.size === 0
                    ? 'Saved. No vendors checked — every vendor stays visible to users.'
                    : `Saved. Users now see ${checked.size} of ${vendors.length} vendors.`
            )
            setConfigured(true)
        } catch (e) {
            setMessageKind('error')
            setMessage(e instanceof Error ? e.message : 'Failed to save vendor allowlist')
        } finally {
            setSaving(false)
        }
    }

    const visible = useMemo(() => {
        const q = filter.trim().toLowerCase()
        if (!q) return vendors
        return vendors.filter(
            (v) => v.id.includes(q) || v.displayName.toLowerCase().includes(q)
        )
    }, [vendors, filter])

    if (loading) return <div className="centered">Loading…</div>

    return (
        <section className="page">
            <h2>Allowlist AI Vendors</h2>
            <p className="page-description">
                Checked vendors are the only ones users can see in the app — the add-vendor
                dropdown, API-key cards and the chat model picker. Unchecking a vendor hides it
                (stored keys are kept). Leaving everything unchecked keeps all vendors visible.
            </p>

            {loadError && <div className="banner error">{loadError}</div>}
            {!loadError && !configured && (
                <div className="banner warning">
                    Not configured yet — all {vendors.length} vendors are currently visible to users.
                </div>
            )}
            {message && <div className={`banner ${messageKind}`}>{message}</div>}

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '1rem 0' }}>
                <input
                    type="search"
                    placeholder="Filter vendors…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    style={{ flex: '0 1 18rem' }}
                />
                <button type="button" onClick={() => setAll(true)}>Check all</button>
                <button type="button" onClick={() => setAll(false)}>Uncheck all</button>
                <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
                    {checked.size} of {vendors.length} checked
                </span>
                <button className="primary" onClick={handleSave} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                </button>
            </div>

            <div className="vendor-list">
                {visible.map((vendor) => (
                    <label
                        key={vendor.id}
                        className="vendor-card"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            cursor: 'pointer',
                            padding: '0.6rem 0.9rem',
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={checked.has(vendor.id)}
                            onChange={() => toggle(vendor.id)}
                            data-testid={`vendor-allow-${vendor.id}`}
                        />
                        <span style={{ fontWeight: 600 }}>{vendor.displayName}</span>
                        <code style={{ opacity: 0.6 }}>{vendor.id}</code>
                        {vendor.native && <span className="status-pill priority">native</span>}
                    </label>
                ))}
                {visible.length === 0 && <p>No vendors match “{filter}”.</p>}
            </div>
        </section>
    )
}
