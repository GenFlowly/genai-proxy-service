import React from 'react'

/** Opens the rules in a new tab, so whatever dialog links to them stays as it was. */
export function ContentRulesLink({ className, children }: { className?: string; children?: React.ReactNode }): React.ReactElement {
    return <a href="/content-rules" target="_blank" rel="noreferrer noopener" className={className}>{children}</a>
}
