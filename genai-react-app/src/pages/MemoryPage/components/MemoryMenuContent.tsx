import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import MobileMenuBody from '../../../components/widgets/MobileMenuBody/MobileMenuBody'
import MenuSearchResults from '../../../components/widgets/MobileMenuBody/MenuSearchResults'
import { Project } from '../../../models/conversationHistory.models'
import { MemoryScope, scopeToParam } from '../../../models/memory.models'
import MemoryScopePanels from './MemoryScopePanels'

const SEARCH_TYPES = ['memory' as const]

interface MemoryMenuContentProps {
    scope: MemoryScope | null
    counts: Record<string, number>
    projects: Project[]
    projectsLoading: boolean
    projectsFailed: boolean
    onClose: () => void
}

/** The Memory page's L2 Menu: Profile and Projects cards, or memory search results. */
export default function MemoryMenuContent({
    scope,
    counts,
    projects,
    projectsLoading,
    projectsFailed,
    onClose,
}: MemoryMenuContentProps): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [query, setQuery] = useState('')

    return (
        <MobileMenuBody
            searchValue={query}
            onSearchChange={setQuery}
            searchPlaceholder={t('layout.mobileMenu.searchMemories')}
            results={query.trim() !== '' ? (
                <MenuSearchResults
                    query={query}
                    types={SEARCH_TYPES}
                    untitledLabel={t('memoryPage.menu.untitled')}
                    onSelect={result => {
                        navigate(`/memory/${encodeURIComponent(result.key)}`)
                        onClose()
                    }}
                    onLeave={onClose}
                />
            ) : undefined}
        >
            <MemoryScopePanels
                menu
                scope={scope}
                counts={counts}
                projects={projects}
                isLoading={projectsLoading}
                hasError={projectsFailed}
                onSelect={next => {
                    navigate(`/memory?scope=${encodeURIComponent(scopeToParam(next))}`)
                    onClose()
                }}
            />
        </MobileMenuBody>
    )
}
