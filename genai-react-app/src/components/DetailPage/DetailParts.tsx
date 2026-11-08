import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Breadcrumbs, Icon, ScrollArea, pageHeaderStyles } from '@genflowly/component-library'
import Navbar from '../navbar/Navbar'
import MobileHeader, { MobileHeaderMenuItem } from '../widgets/MobileHeader/MobileHeader'
import { ICONS } from '../../constants/icons'
import { DiffPart, wordDiff } from '../../utils/wordDiff'
import styles from './DetailPage.module.scss'

export { styles as detailStyles }

interface Crumb {
    label: string
    onClick?: () => void
}

interface DetailShellProps {
    /** Phone header title and second line. */
    title: string
    subtitle?: React.ReactNode
    menuItems?: MobileHeaderMenuItem[]
    menuTitle?: string
    menuContent?: React.ReactNode
    /** Desktop header band. */
    breadcrumbs: Crumb[]
    actions?: React.ReactNode
    /** Phone only: a link back to the parent page, above the content. */
    back?: { label: string; to: string }
    narrow: boolean
    children: React.ReactNode
    'data-testid'?: string
}

/** The detail pages' frame: the phone header or the desktop navbar and breadcrumb band, then the scrolling content. */
export function DetailShell({
    title, subtitle, menuItems, menuTitle, menuContent, breadcrumbs, actions, back, narrow, children, 'data-testid': testId,
}: DetailShellProps): React.ReactElement {
    return (
        <div className={styles.page}>
            {narrow ? (
                <MobileHeader
                    title={title}
                    subtitle={subtitle}
                    menuItems={menuItems}
                    menuTitle={menuTitle}
                    menuContent={menuContent}
                    swipeBackTo={back?.to}
                />
            ) : (
                <>
                    <Navbar />
                    <div className={pageHeaderStyles.header}>
                        <Breadcrumbs variant="onHeader" items={breadcrumbs} />
                        {actions && <div className={`${pageHeaderStyles.actions} ${styles.headerActions}`}>{actions}</div>}
                    </div>
                </>
            )}
            <ScrollArea className={styles.scroll}>
                <div className={styles.content} data-testid={testId}>
                    {narrow && back && (
                        <Link className={styles.back} to={back.to} data-testid="detail-back">
                            <Icon src={ICONS.ALT_ARROW_LEFT} size={16} aria-hidden={true} />
                            {back.label}
                        </Link>
                    )}
                    {children}
                </div>
            </ScrollArea>
        </div>
    )
}

/** Desktop: the main column and the side cards. */
/** Ref for a text field that opens focused with the caret after its text. */
export function focusAtEnd(element: HTMLTextAreaElement | null): void {
    if (!element) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
}

export function DetailColumns({ main, side }: { main: React.ReactNode; side: React.ReactNode }): React.ReactElement {
    return (
        <div className={styles.columns}>
            <div className={styles.mainColumn}>{main}</div>
            <aside className={styles.sideColumn}>{side}</aside>
        </div>
    )
}

export interface DetailRow {
    key: string
    icon: string
    accent?: boolean
    title: string
    summary: React.ReactNode
    to?: string
    onClick?: () => void
}

/** Phone: the short list under the text card. Each row opens its own page or dialog. */
export function DetailRows({ rows, label }: { rows: DetailRow[]; label: string }): React.ReactElement {
    return (
        <nav className={styles.rows} aria-label={label}>
            {rows.map(row => {
                const inner = (
                    <>
                        <span className={`${styles.rowIcon} ${row.accent ? styles.rowIconAccent : ''}`}>
                            <Icon src={row.icon} size={19} aria-hidden={true} />
                        </span>
                        <span className={styles.rowText}>
                            <span className={styles.rowTitle}>{row.title}</span>
                            <span className={styles.rowSummary}>{row.summary}</span>
                        </span>
                        {(row.to || row.onClick) && (
                            <Icon src={ICONS.ALT_ARROW_RIGHT} size={16} className={styles.chevron} aria-hidden={true} />
                        )}
                    </>
                )
                const testId = `detail-row-${row.key}`
                if (row.to) return <Link key={row.key} className={styles.row} to={row.to} data-testid={testId}>{inner}</Link>
                if (row.onClick) {
                    return <button key={row.key} type="button" className={styles.row} onClick={row.onClick} data-testid={testId}>{inner}</button>
                }
                return <div key={row.key} className={`${styles.row} ${styles.rowStatic}`} data-testid={testId}>{inner}</div>
            })}
        </nav>
    )
}

export function SideCard({ title, children, 'data-testid': testId }: { title: string; children: React.ReactNode; 'data-testid'?: string }) {
    return (
        <section className={styles.sideCard} aria-label={title} data-testid={testId}>
            <h2 className={styles.sideTitle}>{title}</h2>
            {children}
        </section>
    )
}

// A date as a stat is too wide for half a side card at the size of a count.
function isWords(value: React.ReactNode): boolean {
    return typeof value === 'string' && value.length > 2
}

export function UsageStats({ stats }: { stats: { value: React.ReactNode; label: string }[] }): React.ReactElement {
    return (
        <div className={styles.stats}>
            {stats.map(stat => (
                <div key={stat.label} className={styles.stat}>
                    <span className={`${styles.statValue} ${isWords(stat.value) ? styles.statWords : ''}`}>{stat.value}</span>
                    <span className={styles.statLabel}>{stat.label}</span>
                </div>
            ))}
        </div>
    )
}

// Unchanged runs longer than this, in words, are shortened to their ends.
const CONTEXT_WORDS = 6

function condense(parts: DiffPart[]): DiffPart[] {
    return parts.map((part, index) => {
        if (part.kind !== 'same') return part
        const words = part.text.split(/(\s+)/)
        if (words.length <= CONTEXT_WORDS * 4) return part
        const head = index === 0 ? [] : words.slice(0, CONTEXT_WORDS * 2)
        const tail = index === parts.length - 1 ? [] : words.slice(-CONTEXT_WORDS * 2)
        return { kind: 'same', text: `${head.join('')}…${tail.join('')}` }
    })
}

/** [after] with the words added since [before] highlighted and the removed ones struck through. */
export function DiffText({ before, after, short = false }: { before: string; after: string; short?: boolean }) {
    const parts = short ? condense(wordDiff(before, after)) : wordDiff(before, after)
    return (
        <>
            {parts.map((part, index) => {
                // A replaced word sits right against its replacement; keep them apart on screen.
                if (part.kind === 'ins' && parts[index - 1]?.kind === 'del') {
                    return <React.Fragment key={index}> <ins className={styles.ins}>{part.text}</ins></React.Fragment>
                }
                if (part.kind === 'ins') return <ins key={index} className={styles.ins}>{part.text}</ins>
                if (part.kind === 'del') return <del key={index} className={styles.del}>{part.text}</del>
                return <span key={index}>{part.text}</span>
            })}
        </>
    )
}

export interface TimelineEntry {
    key: string
    title: string
    badge?: string
    current?: boolean
    date: string
    conversation?: { id: string; title?: string | null; available: boolean }
    facts: { label: string; value: React.ReactNode }[]
    extra?: React.ReactNode
    view?: { label: string; to: string }
}

/** A vertical history, newest first. */
export function Timeline({ entries, label, untitled, deleted }: {
    entries: TimelineEntry[]
    label: string
    untitled: string
    deleted: string
}): React.ReactElement {
    return (
        <ol className={styles.timeline} aria-label={label} data-testid="detail-timeline">
            {entries.map((entry, index) => (
                <li key={entry.key} className={styles.entry} data-testid={`timeline-${entry.key}`}>
                    <div className={styles.rail} aria-hidden="true">
                        <span className={`${styles.dot} ${entry.current ? styles.dotCurrent : ''}`} />
                        {index < entries.length - 1 && <span className={styles.line} />}
                    </div>
                    <article className={styles.entryBody}>
                        <div className={styles.entryHead}>
                            <h3 className={styles.entryTitle}>{entry.title}</h3>
                            {entry.badge && (
                                <span className={`${styles.badge} ${entry.current ? styles.badgeCurrent : ''}`}>{entry.badge}</span>
                            )}
                            <span className={styles.entryDate}>{entry.date}</span>
                        </div>
                        {entry.conversation && (entry.conversation.available ? (
                            <Link className={styles.convLink} to={`/chat/${encodeURIComponent(entry.conversation.id)}`}>
                                <Icon src={ICONS.CHAT_BUBBLE} size={16} aria-hidden={true} />
                                <span>{entry.conversation.title?.trim() || untitled}</span>
                            </Link>
                        ) : (
                            <span className={styles.convGone}>{deleted}</span>
                        ))}
                        {entry.facts.length > 0 && (
                            <dl className={styles.facts}>
                                {entry.facts.map(fact => (
                                    <div key={fact.label} className={styles.fact}>
                                        <dt>{fact.label}</dt>
                                        <dd>{fact.value}</dd>
                                    </div>
                                ))}
                            </dl>
                        )}
                        {entry.extra}
                        {entry.view && (
                            <Link className={styles.viewLink} to={entry.view.to}>
                                {entry.view.label}
                                <Icon src={ICONS.ALT_ARROW_RIGHT} size={14} aria-hidden={true} />
                            </Link>
                        )}
                    </article>
                </li>
            ))}
        </ol>
    )
}

export interface ConversationItem {
    key: string
    conversationId: string
    title?: string | null
    available: boolean
    meta?: string
}

/** Conversations, each opening in Chat; deleted ones are greyed out. */
export function ConversationList({ items, plain = false, untitled, deleted, label }: {
    items: ConversationItem[]
    plain?: boolean
    untitled: string
    deleted: string
    label: string
}): React.ReactElement {
    return (
        <ul className={`${styles.convList} ${plain ? styles.convListPlain : ''}`} aria-label={label} data-testid="detail-conversations">
            {items.map(item => {
                const inner = (
                    <>
                        <span className={styles.rowIcon}>
                            <Icon src={ICONS.CHAT_BUBBLE} size={18} aria-hidden={true} />
                        </span>
                        <span className={styles.rowText}>
                            <span className={`${styles.convTitle} ${item.available ? '' : styles.convTitleGone}`}>
                                {item.available ? item.title?.trim() || untitled : deleted}
                            </span>
                            {item.meta && <span className={styles.rowSummary}>{item.meta}</span>}
                        </span>
                        {item.available && <Icon src={ICONS.ALT_ARROW_RIGHT} size={16} className={styles.chevron} aria-hidden={true} />}
                    </>
                )
                return (
                    <li key={item.key}>
                        {item.available ? (
                            <Link className={styles.convRow} to={`/chat/${encodeURIComponent(item.conversationId)}`}>{inner}</Link>
                        ) : (
                            <div className={styles.convRow}>{inner}</div>
                        )}
                    </li>
                )
            })}
        </ul>
    )
}

export interface MoreMenuItem {
    label: string
    onSelect: () => void
    danger?: boolean
    testId?: string
}

/** Desktop header: the actions people need rarely, behind one button. */
export function MoreMenu({ items, label }: { items: MoreMenuItem[]; label: string }): React.ReactElement | null {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const close = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
        }
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', escape)
        return () => {
            document.removeEventListener('mousedown', close)
            document.removeEventListener('keydown', escape)
        }
    }, [open])

    if (items.length === 0) return null
    return (
        <div className={styles.more} ref={ref}>
            <button
                type="button"
                className={styles.moreButton}
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
                data-testid="detail-more"
            >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                    <circle cx="5" cy="12" r="1.7" />
                    <circle cx="12" cy="12" r="1.7" />
                    <circle cx="19" cy="12" r="1.7" />
                </svg>
            </button>
            {open && (
                <div className={styles.moreMenu} role="menu" aria-label={label}>
                    {items.map(item => (
                        <button
                            key={item.label}
                            type="button"
                            role="menuitem"
                            className={`${styles.moreItem} ${item.danger ? styles.moreItemDanger : ''}`}
                            onClick={() => {
                                setOpen(false)
                                item.onSelect()
                            }}
                            data-testid={item.testId}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
