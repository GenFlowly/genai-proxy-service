import { useCallback, useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import {
    ContentReport,
    ReportAction,
    ReportStatus,
    listContentReports,
    resolveContentReport,
} from '../services/reportsService'

const REASON_LABELS: Record<ContentReport['reason'], string> = {
    SPAM: 'Spam',
    HARASSMENT: 'Harassment or bullying',
    HATE: 'Hate or discrimination',
    SEXUAL: 'Sexual content',
    VIOLENCE: 'Violence or threats',
    ILLEGAL: 'Illegal activity',
    OTHER: 'Something else',
}

const RESOLUTION_LABELS: Record<NonNullable<ContentReport['resolution']>, string> = {
    DISMISSED: 'Dismissed',
    MADE_PRIVATE: 'Made private',
    RESOLVED: 'Resolved',
}

const reportKey = (report: ContentReport) => `${report.entityId}/${report.reporterCustomerId}`
const typeLabel = (report: ContentReport) => (report.entityType === 'CONVERSATION' ? 'Conversation' : 'Instruction')
const handle = (username?: string | null, id?: string | null) => (username ? `@${username}` : id ?? 'Unknown')

/** Content people reported, and what an admin does about each report. */
export default function ReportsPage({ onOpenCountChange }: { onOpenCountChange: (count: number) => void }) {
    const { getAccessTokenSilently } = useAuth0()
    const [status, setStatus] = useState<ReportStatus>('OPEN')
    const [reports, setReports] = useState<ContentReport[]>([])
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [openCount, setOpenCount] = useState(0)
    const [selectedKey, setSelectedKey] = useState<string | null>(null)
    const [note, setNote] = useState('')
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [acting, setActing] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const applyCount = useCallback((count: number) => {
        setOpenCount(count)
        onOpenCountChange(count)
    }, [onOpenCountChange])

    const load = useCallback(async (tab: ReportStatus) => {
        setLoading(true)
        setError(null)
        try {
            const response = await listContentReports(await getAccessTokenSilently(), tab, null)
            setReports(response.reports)
            setNextCursor(response.nextCursor ?? null)
            applyCount(response.openCount)
            setSelectedKey(response.reports[0] ? reportKey(response.reports[0]) : null)
            setNote('')
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load reports')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently, applyCount])

    useEffect(() => {
        void load(status)
    }, [load, status])

    const loadMore = async () => {
        if (!nextCursor) return
        setLoadingMore(true)
        setError(null)
        try {
            const response = await listContentReports(await getAccessTokenSilently(), status, nextCursor)
            setReports((current) => [...current, ...response.reports])
            setNextCursor(response.nextCursor ?? null)
            applyCount(response.openCount)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load reports')
        } finally {
            setLoadingMore(false)
        }
    }

    const selected = reports.find((report) => reportKey(report) === selectedKey) ?? null

    const act = async (action: ReportAction) => {
        if (!selected) return
        setActing(true)
        setError(null)
        try {
            await resolveContentReport(await getAccessTokenSilently(), selected, action, note)
            await load(status)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update the report')
        } finally {
            setActing(false)
        }
    }

    return (
        <section className="page" data-testid="reports-page">
            <h2>Reports</h2>
            <p className="page-description">
                Content other users reported. Act on each one; the reporter is never shown to the owner.
            </p>

            <div className="report-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={status === 'OPEN'} className={status === 'OPEN' ? 'active' : ''} onClick={() => setStatus('OPEN')}>
                    Open · {openCount}
                </button>
                <button type="button" role="tab" aria-selected={status === 'RESOLVED'} className={status === 'RESOLVED' ? 'active' : ''} onClick={() => setStatus('RESOLVED')}>
                    Resolved
                </button>
            </div>

            {error && <div className="banner error">{error}</div>}
            {loading && <p>Loading…</p>}
            {!loading && reports.length === 0 && (
                <p data-testid="reports-empty">{status === 'OPEN' ? 'No open reports.' : 'No resolved reports yet.'}</p>
            )}

            {!loading && reports.length > 0 && (
                <div className="report-layout">
                    <div className="report-table-wrap">
                        <table className="report-table">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Reason</th>
                                    <th>Item</th>
                                    <th>Owner</th>
                                    <th>Reporter</th>
                                    <th>Received</th>
                                </tr>
                            </thead>
                            <tbody>
                                {reports.map((report) => {
                                    const key = reportKey(report)
                                    return (
                                        <tr
                                            key={key}
                                            className={key === selectedKey ? 'selected' : ''}
                                            onClick={() => { setSelectedKey(key); setNote('') }}
                                            data-testid={`report-row-${report.entityId}`}
                                        >
                                            <td>{typeLabel(report)}</td>
                                            <td>{REASON_LABELS[report.reason]}</td>
                                            <td className="item-title">{report.title || '(untitled)'}</td>
                                            <td>{handle(report.ownerUsername, report.ownerCustomerId)}</td>
                                            <td>{handle(report.reporterUsername, report.reporterCustomerId)}</td>
                                            <td style={{ whiteSpace: 'nowrap' }}>{new Date(report.createdAt).toLocaleDateString()}</td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                        {nextCursor && (
                            <div className="report-more">
                                <button type="button" onClick={loadMore} disabled={loadingMore}>
                                    {loadingMore ? 'Loading…' : 'Load more'}
                                </button>
                            </div>
                        )}
                    </div>

                    {selected && (
                        <aside className="report-detail" aria-label="Selected report" data-testid="report-detail">
                            <div>
                                <h3>{REASON_LABELS[selected.reason]}</h3>
                                <span style={{ color: 'var(--text-muted)' }}>{typeLabel(selected)}</span>
                            </div>
                            <dl>
                                <dt>Item</dt><dd>{selected.title || '(untitled)'}</dd>
                                <dt>ID</dt><dd><code>{selected.entityId}</code></dd>
                                <dt>Owner</dt><dd>{handle(selected.ownerUsername, selected.ownerCustomerId)}</dd>
                                <dt>Reporter</dt><dd>{handle(selected.reporterUsername, selected.reporterCustomerId)}</dd>
                                <dt>Received</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                                {selected.resolution && (<><dt>Outcome</dt><dd>{RESOLUTION_LABELS[selected.resolution]}</dd></>)}
                                {selected.resolutionNote && (<><dt>Note</dt><dd>{selected.resolutionNote}</dd></>)}
                            </dl>
                            <div>
                                <div className="field-label">Reported content, as it was when reported</div>
                                <div className="report-snapshot" data-testid="report-snapshot">{selected.contentSnapshot}</div>
                            </div>
                            {selected.details && (
                                <div>
                                    <div className="field-label">Reporter's note</div>
                                    <div data-testid="report-note">{selected.details}</div>
                                </div>
                            )}
                            {selected.status === 'OPEN' && (
                                <>
                                    <div>
                                        <label className="field-label" htmlFor="report-resolution">Resolution note</label>
                                        <textarea
                                            id="report-resolution"
                                            placeholder="What you did and why"
                                            value={note}
                                            onChange={(event) => setNote(event.target.value)}
                                        />
                                    </div>
                                    <div className="report-actions">
                                        <button type="button" onClick={() => act('DISMISS')} disabled={acting} data-testid="report-dismiss">Dismiss</button>
                                        <button type="button" className="danger" onClick={() => act('MAKE_PRIVATE')} disabled={acting} data-testid="report-make-private">Make private</button>
                                        <button type="button" className="primary" onClick={() => act('RESOLVE')} disabled={acting} data-testid="report-resolve">Resolve</button>
                                    </div>
                                </>
                            )}
                        </aside>
                    )}
                </div>
            )}
        </section>
    )
}
