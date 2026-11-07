import React, { useEffect, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import i18n from '../../i18n'
import { DiffText, TimelineEntry } from '../../components/DetailPage/DetailParts'
import { useAuth } from '../../context/AuthContext'
import { InstructionResponse, InstructionUsageResponse } from '../../models/instruction.models'
import { formatServerDateOnly, formatServerDateTime } from '../../utils/timeUtils'

export type InstructionRole = 'OWNER' | 'EDIT' | 'VIEW'

/** The instruction's detail path plus [suffix] and query. */
export function instructionPath(instructionId: string, suffix = '', extra: Record<string, string> = {}): string {
    const search = new URLSearchParams(extra).toString()
    return `/instructions/${encodeURIComponent(instructionId)}${suffix}${search ? `?${search}` : ''}`
}

export function roleLabel(role: InstructionRole): string {
    if (role === 'OWNER') return i18n.t('instructionDetail.page.roleOwner')
    if (role === 'EDIT') return i18n.t('instructionDetail.page.roleEdit')
    return i18n.t('instructionDetail.page.roleView')
}

export function usageSummary(usage: InstructionUsageResponse | undefined): string {
    if (!usage || usage.usageCount === 0 || !usage.lastUsedAt) return i18n.t('instructionDetail.page.usageNever')
    return i18n.t('instructionDetail.page.usageSummary', { count: usage.usageCount, date: formatServerDateOnly(usage.lastUsedAt) })
}

function excerpt(text: string, max = 240): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** One entry per version, newest first, each with what changed since the one before. */
export function instructionHistory(versions: InstructionResponse[], instructionId: string): TimelineEntry[] {
    const latest = versions[0]?.version
    return versions.map((version, index) => {
        const previous = versions[index + 1]
        const facts: TimelineEntry['facts'] = []
        if (previous && previous.name !== version.name) {
            facts.push({ label: i18n.t('instructionDetail.page.name'), value: <DiffText before={previous.name} after={version.name} /> })
        }
        if (previous) {
            if (previous.instruction !== version.instruction) {
                facts.push({
                    label: i18n.t('instructionDetail.page.change'),
                    value: <DiffText before={previous.instruction} after={version.instruction} short />,
                })
            }
        } else {
            facts.push({ label: i18n.t('instructionDetail.page.text'), value: excerpt(version.instruction) })
        }
        const current = version.version === latest
        return {
            key: `v${version.version}`,
            title: i18n.t(previous ? 'instructionDetail.page.edited' : 'instructionDetail.page.created'),
            badge: `v${version.version}`,
            current,
            date: version.createdAt ? formatServerDateTime(version.createdAt) : '',
            facts,
            view: current ? undefined : {
                label: i18n.t('instructionDetail.page.viewVersion', { version: version.version }),
                to: instructionPath(instructionId, '', { version: String(version.version) }),
            },
        }
    })
}

/**
 * What every instruction page reads: its versions (newest first), the one on
 * screen (`?version=N`, else the latest) and the caller's role. A signed-out
 * visitor who can't see it is sent to sign in.
 */
export function useInstructionPage() {
    const { instructionId } = useParams<{ instructionId: string }>()
    const [params] = useSearchParams()
    const { customerInstructions, refreshInstructions, isInstructionsLoaded, isAuthenticated, loginWithRedirect, entitlements } = useAuth()

    useEffect(() => {
        refreshInstructions()
    }, [refreshInstructions])

    const versions = useMemo(
        () => customerInstructions.filter(i => i.id === instructionId).sort((a, b) => b.version - a.version),
        [customerInstructions, instructionId],
    )
    const latest = versions[0]
    const asked = Number(params.get('version'))
    const shown = versions.find(v => v.version === asked && asked !== latest?.version) ?? latest
    const older = !!latest && !!shown && shown.version !== latest.version
    const role: InstructionRole = latest?.role ?? 'VIEW'
    const notFound = isInstructionsLoaded && !latest

    useEffect(() => {
        if (notFound && !isAuthenticated) loginWithRedirect({ appState: { returnTo: window.location.pathname } })
    }, [notFound, isAuthenticated, loginWithRedirect])

    return {
        instructionId: instructionId ?? '',
        versions,
        latest,
        shown,
        older,
        role,
        notFound,
        loading: !isInstructionsLoaded && !latest,
        canShare: role !== 'VIEW' && entitlements.canShare,
        refreshInstructions,
    }
}
