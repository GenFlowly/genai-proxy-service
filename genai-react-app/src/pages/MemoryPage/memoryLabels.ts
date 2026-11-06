import i18n from '../../i18n'
import { Project } from '../../models/conversationHistory.models'
import { MemoryChange, MemoryKind, MemoryPlacement, MemoryScope } from '../../models/memory.models'

export type ProjectNames = Record<string, string>

export function projectNames(projects: Project[] | undefined): ProjectNames {
    return Object.fromEntries((projects ?? []).map(p => [p.projectId, p.name]))
}

export function kindLabel(kind: MemoryKind): string {
    return i18n.t(kind === 'CORE' ? 'memoryPage.kinds.core' : 'memoryPage.kinds.episodic')
}

export function projectLabel(projectId: string, names: ProjectNames): string {
    return names[projectId] ?? i18n.t('memoryPage.scopes.unknownProject')
}

export function scopeTitle(scope: MemoryScope, names: ProjectNames): string {
    if (scope.type === 'project') return projectLabel(scope.projectId, names)
    return i18n.t(scope.kind === 'CORE' ? 'memoryPage.scopes.coreTitle' : 'memoryPage.scopes.episodicTitle')
}

export function scopeSubtitle(scope: MemoryScope): string {
    if (scope.type === 'project') return i18n.t('memoryPage.scopes.projectSubtitle')
    return i18n.t(scope.kind === 'CORE' ? 'memoryPage.scopes.coreSubtitle' : 'memoryPage.scopes.episodicSubtitle')
}

/** "Profile · Core", "Market research · Episodic". */
export function placementLabel(placement: MemoryPlacement, names: ProjectNames): string {
    const where = placement.projectId ? projectLabel(placement.projectId, names) : i18n.t('memoryPage.scopes.profile')
    return `${where} · ${kindLabel(placement.kind)}`
}

export function placementsLabel(placements: MemoryPlacement[] | null | undefined, names: ProjectNames): string {
    if (!placements || placements.length === 0) return i18n.t('memoryPage.changes.nowhere')
    return placements.map(p => placementLabel(p, names)).join(', ')
}

/** Help line for a kind in Profile or in a project. */
export function kindHelp(kind: MemoryKind, inProject: boolean): string {
    const key = kind === 'CORE'
        ? (inProject ? 'memoryPage.move.coreHelpProject' : 'memoryPage.move.coreHelpProfile')
        : (inProject ? 'memoryPage.move.episodicHelpProject' : 'memoryPage.move.episodicHelpProfile')
    return i18n.t(key)
}

/** What happened, as the change log's entry title. */
export function changeTitle(change: MemoryChange): string {
    const fromNote = change.sourceType === 'NOTE'
    switch (change.type) {
        case 'LEARNED': return i18n.t(fromNote ? 'memoryPage.changes.learnedNote' : 'memoryPage.changes.learned')
        case 'UPDATED': return i18n.t(fromNote ? 'memoryPage.changes.updatedNote' : 'memoryPage.changes.updated')
        case 'ADDED_BY_YOU': return i18n.t('memoryPage.changes.addedByYou')
        case 'EDITED_BY_YOU': return i18n.t('memoryPage.changes.editedByYou')
        case 'MOVED': return i18n.t('memoryPage.changes.moved')
        case 'COPIED': return i18n.t('memoryPage.changes.copied')
        case 'REMOVED_FROM_PROJECT':
            return i18n.t(change.conversationId
                ? 'memoryPage.changes.removedInConversation'
                : 'memoryPage.changes.removedFromProject')
        case 'LEGACY': return i18n.t('memoryPage.changes.legacy')
        default: return change.type
    }
}
