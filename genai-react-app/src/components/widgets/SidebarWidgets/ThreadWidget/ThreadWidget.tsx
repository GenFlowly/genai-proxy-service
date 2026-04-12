import React from 'react'
import { useConversation } from '../../../../context/ConversationContext'
import { useLayout } from '../../../../context/LayoutContext'
import ThreadPromptItem from './ThreadPromptItem'
import ThreadResponseItem from './ThreadResponseItem'
import styles from './ThreadWidget.module.scss'

export default function ThreadWidget({ 'data-testid': testId }: { 'data-testid'?: string } = {}) {
    const { conversationBlockList } = useConversation()
    const { isLeftSidebarExpanded } = useLayout()

    const collapsed = !isLeftSidebarExpanded

    return (
        <div className={styles.threadWidget} data-testid={testId || "thread-widget"}>
            {!collapsed && <h3 className={styles.title}>Thread</h3>}

            {conversationBlockList.length === 0 || (conversationBlockList.length === 1 && !conversationBlockList[0].prompt && conversationBlockList[0].status === 'draft') ? (
                !collapsed && <p className={styles.emptyState} data-testid="thread-empty-state">No conversation yet</p>
            ) : (
                <div className={styles.threadList}>
                    {conversationBlockList.map((block) => {
                        const hasPrompt = block.prompt.trim().length > 0
                        const hasResponses = block.status === 'resolved' || block.responseMessages.length > 0

                        // Don't show blocks that are completely empty
                        if (!hasPrompt && !hasResponses) {
                            return null
                        }

                        return (
                            <div key={block.conversationBlockId} className={styles.threadBlock}>
                                {hasPrompt && (
                                    <ThreadPromptItem
                                        conversationBlockId={block.conversationBlockId}
                                        prompt={block.prompt}
                                        collapsed={collapsed}
                                    />
                                )}
                                {hasResponses && (
                                    <ThreadResponseItem
                                        conversationBlockId={block.conversationBlockId}
                                        responseCount={block.responseMessages.length}
                                        collapsed={collapsed}
                                    />
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
