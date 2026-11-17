import React, { useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router'
import i18n from '../../i18n'
import { useMemoryDetail, useProjects } from '../../hooks/queries/useMemories'
import { DiffText, TimelineEntry, ConversationItem, detailStyles } from '../../components/DetailPage/DetailParts'
import { CustomerMemory, MemoryChange, MemoryPlacement, MemoryScope, MemoryUsage, placementIn, scopeFromParam, scopeToParam } from '../../models/memory.models'
import { formatServerDateOnly, formatServerDateTime, formatServerTime } from '../../utils/timeUtils'
import { ProjectNames, changeTitle, kindLabel, placementsLabel, projectLabel, projectNames } from './memoryLabels'

export const MAX_TEXT_CHARS = 500

export function scopeOf(memory: CustomerMemory): MemoryScope {
    const first = memory.placements[0]
    if (first?.projectId) return { type: 'project', projectId: first.projectId }
    return { type: 'profile', kind: first?.kind ?? memory.kind }
}

/** "Every conversation · Core", "When relevant · Episodic", "Market research · Episodic". */
export function appliesLabel(placement: MemoryPlacement, names: ProjectNames): string {
    const where = placement.projectId
        ? projectLabel(placement.projectId, names)
        : i18n.t(placement.kind === 'CORE' ? 'memoryPage.page.everywhere' : 'memoryPage.page.whenRelevant')
    return `${where} · ${kindLabel(placement.kind)}`
}

export function usageSummary(memory: CustomerMemory): string {
    if (memory.hitCount === 0) return i18n.t('memoryPage.page.usageNever')
    if (!memory.lastUsedAt) return i18n.t('memoryPage.page.usageCount', { count: memory.hitCount })
    return i18n.t('memoryPage.page.usageSummary', { count: memory.hitCount, date: formatServerDateOnly(memory.lastUsedAt) })
}

/** The memory's detail path plus [suffix], keeping the list it came from. */
export function memorySubPath(memoryId: string, suffix: string, scope: MemoryScope | null, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams(extra)
    if (scope) params.set('scope', scopeToParam(scope))
    const search = params.toString()
    return `/memory/${encodeURIComponent(memoryId)}${suffix}${search ? `?${search}` : ''}`
}

/** A memory's changes as a timeline, newest first. */
export function memoryHistory(
    changes: MemoryChange[],
    memory: CustomerMemory,
    names: ProjectNames,
    scope: MemoryScope | null,
): TimelineEntry[] {
    return changes.map(change => {
        const facts: TimelineEntry['facts'] = []
        if (change.type === 'LEGACY') {
            facts.push({
                label: i18n.t('memoryPage.changes.note'),
                value: i18n.t('memoryPage.changes.legacyNote', { date: formatServerDateOnly(change.createdAt) }),
            })
        }
        if (change.noteKey) facts.push({ label: i18n.t('memoryPage.changes.note'), value: i18n.t('memoryPage.changes.fromNote') })
        if (change.youSaid) facts.push({ label: i18n.t('memoryPage.changes.youSaid'), value: `“${change.youSaid}”` })
        if (change.reason) facts.push({ label: i18n.t('memoryPage.page.why'), value: change.reason })
        if (change.previousText != null && change.text != null) {
            facts.push({ label: i18n.t('memoryPage.page.change'), value: <DiffText before={change.previousText} after={change.text} /> })
        } else if (change.text != null && change.type !== 'LEGACY') {
            facts.push({ label: i18n.t('memoryPage.page.savedAs'), value: change.text })
        }
        const moved = change.version == null && (change.from || change.to)
        const current = change.version != null && change.version === memory.version
        return {
            key: change.changeId,
            title: changeTitle(change),
            badge: change.version != null
                ? `v${change.version}`
                : change.type === 'LEGACY' ? undefined : i18n.t('memoryPage.changes.noVersion'),
            current,
            date: formatServerDateTime(change.createdAt),
            conversation: change.conversationId
                ? { id: change.conversationId, title: change.conversationTitle, available: change.conversationAvailable !== false }
                : undefined,
            facts,
            extra: moved ? (
                <div className={detailStyles.placementMove}>
                    <span className={`${detailStyles.chip} ${detailStyles.fromChip}`}>{placementsLabel(change.from, names)}</span>
                    <span aria-hidden="true" className={detailStyles.muted}>→</span>
                    <span className={`${detailStyles.chip} ${detailStyles.chipAccent}`}>{placementsLabel(change.to, names)}</span>
                </div>
            ) : undefined,
            view: change.version != null && !current
                ? {
                    label: i18n.t('memoryPage.page.viewVersion', { version: change.version }),
                    to: memorySubPath(memory.memoryId, '', scope, { version: String(change.version) }),
                }
                : undefined,
        }
    })
}

/** The replies a memory was used in, one item per conversation, newest first. */
export function usageByConversation(items: MemoryUsage[]): ConversationItem[] {
    const groups = new Map<string, { usage: MemoryUsage; count: number }>()
    for (const usage of items) {
        const group = groups.get(usage.conversationId)
        if (group) group.count += 1
        else groups.set(usage.conversationId, { usage, count: 1 })
    }
    return Array.from(groups.values()).map(({ usage, count }) => ({
        key: usage.conversationId,
        conversationId: usage.conversationId,
        title: usage.conversationTitle,
        available: usage.conversationAvailable,
        meta: i18n.t('memoryPage.page.conversationUses', { count, date: formatServerDateTime(usage.usedAt) }),
    }))
}

export function lastUsedLabel(memory: CustomerMemory): string {
    if (memory.lastUsedAt) return i18n.t('memoryPage.page.lastUsed', { time: formatServerTime(memory.lastUsedAt) })
    return i18n.t(memory.hitCount > 0 ? 'memoryPage.page.lastUseUnknown' : 'memoryPage.page.notYet')
}

/**
 * Replies counted before the usage log existed: the hit counter has them,
 * the log doesn't. Known only once every page of the log is loaded.
 */
export function unlistedReplies(memory: CustomerMemory, listedReplies: number, complete: boolean): number {
    return complete ? Math.max(0, memory.hitCount - listedReplies) : 0
}

/** What every memory page reads: the memory, its detail, project names and the list it came from. */
export function useMemoryPage() {
    const { memoryId } = useParams<{ memoryId: string }>()
    const [params] = useSearchParams()
    const detailQuery = useMemoryDetail(memoryId)
    const projectsQuery = useProjects()
    const names = useMemo(() => projectNames(projectsQuery.data ?? []), [projectsQuery.data])
    const detail = detailQuery.data
    const memory = detail?.memory
    const requested = params.get('scope') ? scopeFromParam(params.get('scope')) : null
    const scope: MemoryScope | null = memory
        ? (requested && placementIn(memory, requested) ? requested : scopeOf(memory))
        : requested
    return { memoryId, params, detailQuery, detail, memory, names, scope }
}
