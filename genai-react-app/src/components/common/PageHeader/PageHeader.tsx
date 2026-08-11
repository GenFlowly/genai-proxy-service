import React from 'react'
import styles from './PageHeader.module.scss'

// All header styling lives here; concrete headers (ConversationHeader,
// NotesHeader, ...) compose this component and bring no styles of their own.
// `pageHeaderStyles` is exported so they can style elements they pass into
// `actions` (e.g. pageHeaderStyles.actionButton).
export { styles as pageHeaderStyles }

interface PageHeaderProps {
    title: string
    actions?: React.ReactNode
    children?: React.ReactNode
    'data-testid'?: string
}

export default function PageHeader({ title, actions, children, 'data-testid': testId }: PageHeaderProps): React.ReactElement {
    return (
        <div className={styles.header} data-testid={testId}>
            <h1 className={styles.title} title={title}>
                {title}
            </h1>
            <div className={styles.actions}>{actions}</div>
            {children}
        </div>
    )
}
