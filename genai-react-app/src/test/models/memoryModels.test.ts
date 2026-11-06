import {
    CustomerMemory,
    PROFILE_CORE,
    isProfileMemory,
    memoriesIn,
    memoryCounts,
    placementIn,
    scopeFromParam,
    scopeToParam,
} from '../../models/memory.models'
import {
    changeTitle,
    kindHelp,
    placementsLabel,
    projectNames,
    scopeSubtitle,
    scopeTitle,
} from '../../pages/MemoryPage/memoryLabels'

const memory = (id: string, placements: CustomerMemory['placements'], updatedAt = 't'): CustomerMemory => ({
    memoryId: id, text: id, kind: placements[0].kind, sourceType: 'CONVERSATION', createdAt: 't', updatedAt,
    placements, version: 1, tracked: true, hitCount: 0,
})

describe('memory scopes', () => {
    test('round-trip through the URL', () => {
        expect(scopeFromParam(null)).toEqual(PROFILE_CORE)
        expect(scopeFromParam('core')).toEqual(PROFILE_CORE)
        expect(scopeFromParam('episodic')).toEqual({ type: 'profile', kind: 'EPISODIC' })
        expect(scopeFromParam('PRJa')).toEqual({ type: 'project', projectId: 'PRJa' })
        for (const param of ['core', 'episodic', 'PRJa']) expect(scopeToParam(scopeFromParam(param))).toBe(param)
    })

    test('a list holds what applies there, newest first, and counts add up per place', () => {
        const memories = [
            memory('old', [{ projectId: null, kind: 'CORE' }], '2026-01-01'),
            memory('new', [{ projectId: null, kind: 'CORE' }], '2026-02-01'),
            memory('epi', [{ projectId: null, kind: 'EPISODIC' }]),
            memory('shared', [{ projectId: 'PRJa', kind: 'CORE' }, { projectId: 'PRJb', kind: 'EPISODIC' }]),
        ]

        expect(memoriesIn(memories, PROFILE_CORE).map(m => m.memoryId)).toEqual(['new', 'old'])
        expect(memoriesIn(memories, { type: 'project', projectId: 'PRJb' }).map(m => m.memoryId)).toEqual(['shared'])
        expect(memoryCounts(memories)).toEqual({ core: 2, episodic: 1, PRJa: 1, PRJb: 1 })
        expect(placementIn(memories[3], { type: 'project', projectId: 'PRJb' })).toEqual({ projectId: 'PRJb', kind: 'EPISODIC' })
        expect(isProfileMemory(memories[0])).toBe(true)
        expect(isProfileMemory(memories[3])).toBe(false)
    })
})

describe('memory labels', () => {
    const names = projectNames([{ projectId: 'PRJa', name: 'Market research', createdAt: 't', updatedAt: 't' }])

    test('titles and subtitles name the list', () => {
        expect(scopeTitle(PROFILE_CORE, names)).toBe('Core memories')
        expect(scopeTitle({ type: 'profile', kind: 'EPISODIC' }, names)).toBe('Episodic memories')
        expect(scopeTitle({ type: 'project', projectId: 'PRJa' }, names)).toBe('Market research')
        expect(scopeTitle({ type: 'project', projectId: 'PRJgone' }, names)).toBe('Project')
        expect(scopeSubtitle({ type: 'project', projectId: 'PRJa' })).toBe("Project · used only in this project's conversations")
        expect(scopeSubtitle({ type: 'profile', kind: 'EPISODIC' })).toBe('Profile · recalled when a conversation calls for it')
    })

    test('placements and kinds read in words', () => {
        expect(placementsLabel([{ projectId: null, kind: 'CORE' }, { projectId: 'PRJa', kind: 'EPISODIC' }], names))
            .toBe('Profile · Core, Market research · Episodic')
        expect(placementsLabel([], names)).toBe('—')
        expect(kindHelp('EPISODIC', true)).toBe('Episodic: recalled only when a conversation in this project calls for it.')
        expect(kindHelp('CORE', false)).toBe('Core: included in every conversation.')
    })

    test('every change type has a title', () => {
        const at = (type: any, extra = {}) => changeTitle({ changeId: 'c', type, createdAt: 't', ...extra })
        expect(at('LEARNED', { sourceType: 'NOTE' })).toBe('Learned from a note')
        expect(at('UPDATED')).toBe('Updated from a conversation')
        expect(at('UPDATED', { sourceType: 'NOTE' })).toBe('Updated from a note')
        expect(at('ADDED_BY_YOU')).toBe('Added by you')
        expect(at('COPIED')).toBe('Copied by you')
        expect(at('REMOVED_FROM_PROJECT')).toBe('Removed from a project')
        expect(at('REMOVED_FROM_PROJECT', { conversationId: 'C1' })).toBe('Removed from this project in a conversation')
        expect(at('LEGACY')).toBe('Learned before changes were recorded')
        expect(at('SOMETHING_NEW')).toBe('SOMETHING_NEW')
        expect(at('EDITED_BY_YOU')).toBe('Edited by you')
    })
})
