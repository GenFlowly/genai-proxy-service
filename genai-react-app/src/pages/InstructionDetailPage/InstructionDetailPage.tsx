import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Icon, InputTextWithHint, PillButton, TextContainer, TextEditor, pageHeaderStyles } from '@genflowly/component-library'
import {
    ConversationList,
    DetailColumns,
    DetailRows,
    DetailShell,
    MoreMenu,
    SideCard,
    Timeline,
    UsageStats,
    detailStyles as styles,
} from '../../components/DetailPage/DetailParts'
import ShareModal, { VisibilityMode } from '../../components/common/ShareModal/ShareModal'
import { ICONS } from '../../constants/icons'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useSharedItemModeration } from '../../hooks/useSharedItemModeration'
import { useInstructionSharedUsers, useInstructionUsage } from '../../hooks/queries/useInstructionDetail'
import { InstructionResponse } from '../../models/instruction.models'
import { SearchUserResponse } from '../../models/user.models'
import {
    createInstruction,
    deleteInstruction,
    getInstructionSharedUsers,
    shareInstruction,
    unshareInstruction,
} from '../../services/instructionService'
import { ModerationError } from '../../services/moderationService'
import { formatServerDateOnly, formatServerTime } from '../../utils/timeUtils'
import { instructionHistory, instructionPath, roleLabel, usageSummary, useInstructionPage } from './instructionDetail'

// Longer instructions are clipped on a phone, with a button to show the rest.
const CLIP_CHARS = 600
const SIDE_CONVERSATIONS = 4

/** The emoji tile and name at the top of an instruction's card. */
export function InstructionHead({ instruction }: { instruction: InstructionResponse }) {
    return (
        <div className={styles.cardHead}>
            {instruction.icon && (
                <span className={styles.iconTile} role="img" aria-hidden="true" style={instruction.color ? { background: instruction.color } : undefined}>
                    {instruction.icon}
                </span>
            )}
            <h2 className={styles.cardTitle}>{instruction.name}</h2>
        </div>
    )
}

export function InstructionChips({ instruction }: { instruction: InstructionResponse }) {
    if (!instruction.category && !instruction.tags?.length) return null
    return (
        <ul className={styles.chips} aria-label="Tags">
            {instruction.category && <li className={`${styles.chip} ${styles.chipAccent}`}>{instruction.category}</li>}
            {(instruction.tags ?? []).map(tag => <li key={tag} className={styles.chip}>#{tag}</li>)}
        </ul>
    )
}

function initials(user: SearchUserResponse): string {
    const name = user.name || user.username || '?'
    return name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()
}

/**
 * One instruction: its name, tags and text with one Edit action, who it is
 * shared with, how you used it and its versions. Phones show the last three as
 * rows that open their own pages; desktop shows the versions under the text
 * and the rest beside it. `?version=N` shows an older version to restore.
 */
export default function InstructionDetailPage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { isNarrow } = useResponsiveBreakpoints()
    const { getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    const { instructionId, versions, latest, shown, older, role, notFound, loading, canShare, refreshInstructions } = useInstructionPage()
    const canEdit = role !== 'VIEW'
    const usageQuery = useInstructionUsage(instructionId, !!latest)
    const sharesQuery = useInstructionSharedUsers(instructionId, !!latest && canEdit)
    const moderation = useSharedItemModeration({
        entityType: 'INSTRUCTION',
        entityId: instructionId,
        enabled: !!latest && role !== 'OWNER',
        onGone: () => navigate('/instructions'),
    })

    const [editing, setEditing] = useState(false)
    const [name, setName] = useState('')
    const [text, setText] = useState('')
    const [saving, setSaving] = useState(false)
    const [shareOpen, setShareOpen] = useState(false)
    const [showFull, setShowFull] = useState(false)

    useEffect(() => {
        setEditing(false)
        setShowFull(false)
    }, [instructionId])

    useEffect(() => {
        document.title = latest?.name ? `${latest.name} | Instructions` : 'Instructions'
    }, [latest?.name])

    const latestPath = instructionPath(instructionId)
    const nextVersion = (latest?.version ?? 0) + 1

    const startEdit = () => {
        if (!shown) return
        if (isNarrow) {
            navigate(instructionPath(instructionId, '/edit', older ? { version: String(shown.version) } : {}))
            return
        }
        setName(shown.name)
        setText(shown.instruction)
        setEditing(true)
    }

    const save = async () => {
        if (!text.trim()) return
        setSaving(true)
        try {
            const created = await createInstruction(await getAccessTokenSilently(), {
                instruction: text,
                instructionName: name || undefined,
                existingInstructionId: instructionId,
            })
            showToast(t('instructionDetail.page.saved', { version: created.version }))
            setEditing(false)
            refreshInstructions()
            if (created.id !== instructionId) navigate(instructionPath(created.id), { replace: true })
            else if (older) navigate(latestPath, { replace: true })
        } catch (error) {
            console.error('Failed to save instruction', error)
            showToast(error instanceof ModerationError ? t('moderation.saveRefusedByFilter') : t('instructionDetail.instructionDetailPage.saveFailedAlert'))
        } finally {
            setSaving(false)
        }
    }

    const remove = async () => {
        if (!window.confirm(t('instructionDetail.instructionDetailPage.deleteConfirm'))) return
        try {
            await deleteInstruction(await getAccessTokenSilently(), instructionId)
            refreshInstructions()
            navigate('/instructions')
        } catch (error) {
            console.error('Failed to delete instruction', error)
            showToast(t('instructionDetail.instructionDetailPage.deleteFailedAlert'))
        }
    }

    const saveShares = async (_mode: VisibilityMode, users: SearchUserResponse[], removed: SearchUserResponse[]) => {
        try {
            const token = await getAccessTokenSilently()
            for (const user of users) await shareInstruction(token, instructionId, user.customerId, user.role || 'VIEW')
            for (const user of removed) await unshareInstruction(token, instructionId, user.customerId)
            showToast(t('instructionDetail.instructionDetailPage.shareUpdatedAlert'))
            sharesQuery.refetch()
        } catch (error) {
            console.error('Failed to share instruction', error)
            showToast(error instanceof ModerationError
                ? t(error.code === 'CONTENT_BLOCKED' ? 'moderation.shareRefusedByFilter' : 'moderation.shareRefusedByBlock')
                : t('instructionDetail.instructionDetailPage.shareFailedAlert'))
        }
    }

    const people = (sharesQuery.data ?? []).filter(user => user.customerId !== 'PUBLIC')
    const isPublic = (sharesQuery.data ?? []).some(user => user.customerId === 'PUBLIC')
    const sharingSummary = !canEdit
        ? t('instructionDetail.page.sharedWithYouView')
        : people.length === 0 && !isPublic
            ? t('instructionDetail.page.onlyYou')
            : isPublic ? t('instructionDetail.page.everyone') : t('instructionDetail.page.youAndOthers', { count: people.length })
    const usage = usageQuery.data
    const history = instructionHistory(versions, instructionId)
    const long = (shown?.instruction.length ?? 0) > CLIP_CHARS
    const clipped = isNarrow && long && !showFull

    const textCard = shown && (
        <section className={styles.card} aria-label={t('instructionDetail.page.title')} data-testid="instruction-card">
            {editing ? (
                <>
                    <InputTextWithHint
                        hint={t('instructionDetail.instructionDetailPage.nameHint')}
                        placeholder={t('instructionDetail.instructionDetailPage.namePlaceholder')}
                        value={name}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
                    />
                    <TextEditor id="instruction-inline-editor" value={text} onChange={setText} disableCache height="360px" fullWidth />
                    <div className={styles.desktopActions}>
                        <PillButton variant="secondary" label={t('instructionDetail.page.cancel')} onClick={() => setEditing(false)} disabled={saving} />
                        <PillButton
                            label={saving ? t('instructionDetail.instructionDetailPage.savingLabel') : t('instructionDetail.page.save', { next: nextVersion })}
                            onClick={save}
                            disabled={saving || !text.trim()}
                            data-testid="instruction-save"
                        />
                    </div>
                </>
            ) : (
                <>
                    <InstructionHead instruction={shown} />
                    <InstructionChips instruction={shown} />
                    <div className={`${styles.markdown} ${clipped ? styles.clipped : ''}`} data-testid="instruction-text">
                        <TextContainer content={shown.instruction} showCopyButton={false} />
                    </div>
                    {isNarrow && long && (
                        <button type="button" className={styles.textToggle} onClick={() => setShowFull(value => !value)} aria-expanded={showFull}>
                            {t(showFull ? 'instructionDetail.page.showLess' : 'instructionDetail.page.showFull')}
                        </button>
                    )}
                    <div className={styles.cardFoot}>
                        <span className={styles.footNote}>
                            <strong>{t('instructionDetail.page.version', { version: shown.version })}</strong>
                            {shown.createdAt ? ` · ${formatServerDateOnly(shown.createdAt)}` : ''}
                        </span>
                        {canEdit && (
                            <PillButton
                                variant={older ? 'primary' : 'secondary'}
                                label={older ? t('instructionDetail.page.restore', { next: nextVersion }) : t('instructionDetail.page.edit')}
                                onClick={startEdit}
                                data-testid="instruction-edit"
                            />
                        )}
                    </div>
                </>
            )}
        </section>
    )

    const olderBanner = older && shown && latest && (
        <div className={styles.banner} role="status" data-testid="instruction-older">
            <span>{t('instructionDetail.page.olderBanner', { version: shown.version, latest: latest.version })}</span>
            <Link className={styles.bannerLink} to={latestPath}>{t('instructionDetail.page.backToLatest')}</Link>
        </div>
    )

    const usageItems = (usage?.conversations ?? []).map(conversation => ({
        key: conversation.conversationId,
        conversationId: conversation.conversationId,
        title: conversation.title,
        available: true,
        meta: conversation.firstUsedAt ? t('instructionDetail.page.firstUsed', { date: formatServerDateOnly(conversation.firstUsedAt) }) : undefined,
    }))

    return (
        <DetailShell
            narrow={isNarrow}
            swipeBack={{ to: '/instructions' }}
            title={t('instructionDetail.page.title')}
            subtitle={latest ? (moderation.owner ? t('moderation.sharedBy', { name: moderation.ownerLabel }) : roleLabel(role)) : undefined}
            menuItems={latest ? [
                ...(canShare ? [{ label: t('instructionDetail.instructionDetailPage.share'), onClick: () => setShareOpen(true), 'data-testid': 'instruction-share' }] : []),
                ...(role === 'OWNER' ? [{ label: t('instructionDetail.instructionDetailPage.delete'), onClick: remove, 'data-testid': 'instruction-delete' }] : []),
                ...moderation.actions.map(action => ({ label: action.label, onClick: action.onSelect, 'data-testid': action.testId })),
            ] : undefined}
            breadcrumbs={[
                { label: t('instructionDetail.instructionDetailPage.breadcrumbInstructions'), onClick: () => navigate('/instructions') },
                { label: latest?.name || t('instructionDetail.page.title') },
            ]}
            actions={latest ? (
                <>
                    {canShare && (
                        <PillButton
                            label={t('instructionDetail.instructionDetailPage.share')}
                            icon={ICONS.SHARE}
                            className={pageHeaderStyles.actionButton}
                            onClick={() => setShareOpen(true)}
                            data-testid="instruction-share"
                        />
                    )}
                    {role === 'OWNER' && (
                        <MoreMenu
                            label={t('instructionDetail.page.more')}
                            items={[{ label: t('instructionDetail.page.deleteInstruction'), onSelect: remove, danger: true, testId: 'instruction-delete' }]}
                        />
                    )}
                    {moderation.actions.length > 0 && <MoreMenu label={t('instructionDetail.page.more')} items={moderation.actions} />}
                </>
            ) : undefined}
            data-testid="instruction-detail"
        >
            {loading && <div className={styles.state}>{t('instructionDetail.page.loading')}</div>}
            {notFound && (
                <div className={styles.state} data-testid="instruction-not-found">
                    <p>{t('instructionDetail.page.notFound')}</p>
                    <PillButton variant="secondary" label={t('instructionDetail.page.backToList')} onClick={() => navigate('/instructions')} />
                </div>
            )}
            {latest && shown && (isNarrow ? (
                <>
                    {olderBanner}
                    {textCard}
                    <DetailRows
                        label={t('instructionDetail.page.rows')}
                        rows={[
                            {
                                key: 'sharing',
                                icon: ICONS.SHARE,
                                accent: true,
                                title: t('instructionDetail.page.sharing'),
                                summary: sharingSummary,
                                onClick: canShare ? () => setShareOpen(true) : undefined,
                            },
                            {
                                key: 'usage',
                                icon: ICONS.CHAT_BUBBLE,
                                title: t('instructionDetail.page.usage'),
                                summary: usageQuery.isPending ? t('instructionDetail.page.loading') : usageSummary(usage),
                                to: instructionPath(instructionId, '/usage'),
                            },
                            {
                                key: 'versions',
                                icon: ICONS.HISTORY,
                                title: t('instructionDetail.page.versions'),
                                summary: latest.createdAt
                                    ? t('instructionDetail.page.versionsSummary', { version: latest.version, date: formatServerDateOnly(latest.createdAt) })
                                    : t('instructionDetail.page.version', { version: latest.version }),
                                to: instructionPath(instructionId, '/history'),
                            },
                        ]}
                    />
                </>
            ) : (
                <DetailColumns
                    main={(
                        <>
                            {olderBanner}
                            {textCard}
                            <section aria-label={t('instructionDetail.page.versions')} className={styles.field}>
                                <h2 className={styles.sectionTitle}>{t('instructionDetail.page.versions')}</h2>
                                <Timeline
                                    entries={history}
                                    label={t('instructionDetail.page.versions')}
                                    untitled=""
                                    deleted=""
                                />
                            </section>
                        </>
                    )}
                    side={(
                        <>
                            <SideCard title={t('instructionDetail.page.sharing')} data-testid="instruction-sharing">
                                <div className={styles.sideSummary}>
                                    <span className={`${styles.rowIcon} ${styles.rowIconAccent}`}>
                                        <Icon src={ICONS.SHARE} size={19} aria-hidden={true} />
                                    </span>
                                    <span className={styles.rowText}>
                                        <span className={styles.rowTitle}>
                                            {role === 'OWNER' ? t('instructionDetail.page.youOwnIt') : canEdit ? t('instructionDetail.page.sharedWithYouEdit') : t('instructionDetail.page.sharedWithYouView')}
                                        </span>
                                        {canEdit && (
                                            <span className={styles.rowSummary}>
                                                {isPublic ? t('instructionDetail.page.everyone') : t('instructionDetail.page.peopleCanUse', { count: people.length })}
                                            </span>
                                        )}
                                    </span>
                                </div>
                                {people.length > 0 && (
                                    <ul className={styles.people}>
                                        {people.map(user => (
                                            <li key={user.customerId} className={styles.person}>
                                                {user.picture
                                                    ? <img className={styles.avatar} src={user.picture} alt="" />
                                                    : <span className={styles.avatar} aria-hidden="true">{initials(user)}</span>}
                                                <span className={styles.personName}>{user.name || user.username}</span>
                                                <span className={styles.muted}>
                                                    {user.role === 'EDIT' ? t('instructionDetail.page.canEdit') : t('instructionDetail.page.canView')}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {canShare && (
                                    <PillButton variant="secondary" label={t('instructionDetail.page.manageSharing')} onClick={() => setShareOpen(true)} />
                                )}
                            </SideCard>
                            <SideCard title={t('instructionDetail.page.usage')} data-testid="instruction-usage">
                                <UsageStats
                                    stats={[
                                        { value: usage?.usageCount ?? 0, label: t('instructionDetail.page.chatsUsedIt') },
                                        {
                                            value: usage?.lastUsedAt ? formatServerDateOnly(usage.lastUsedAt) : '—',
                                            label: usage?.lastUsedAt
                                                ? t('instructionDetail.page.lastUsed', { time: formatServerTime(usage.lastUsedAt) })
                                                : t('instructionDetail.page.usageNever'),
                                        },
                                    ]}
                                />
                                {usageItems.length > 0 && (
                                    <ConversationList
                                        plain
                                        items={usageItems.slice(0, SIDE_CONVERSATIONS)}
                                        label={t('instructionDetail.page.usedIn')}
                                        untitled={t('memoryPage.changes.untitledConversation')}
                                        deleted={t('memoryPage.changes.deletedConversation')}
                                    />
                                )}
                                {(usage?.usageCount ?? 0) > 0 && (
                                    <Link className={styles.viewLink} to={instructionPath(instructionId, '/usage')}>
                                        {t('instructionDetail.page.seeAllUsage')}
                                    </Link>
                                )}
                            </SideCard>
                        </>
                    )}
                />
            ))}

            <ShareModal
                isOpen={shareOpen}
                onClose={() => setShareOpen(false)}
                onSave={saveShares}
                entityId={latest ? instructionId : undefined}
                fetchSharedUsers={async id => getInstructionSharedUsers(await getAccessTokenSilently(), id)}
            />
            {moderation.dialogs}
        </DetailShell>
    )
}
