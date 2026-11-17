import React from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, InputTextWithHint, Modal } from '@genflowly/component-library'
import { DeleteConfirmModal } from '../../common/DeleteConfirmModal/DeleteConfirmModal'
import { ICONS } from '../../../constants/icons'
import type { ConversationHistory } from './useConversationHistory'
import styles from './ConversationHistory.module.scss'

/**
 * The dialogs the Projects and Chats widgets open: create and rename a
 * project, move a conversation to a project, and the two delete
 * confirmations.
 */
export default function ConversationHistoryDialogs({ history }: { history: ConversationHistory }): React.ReactElement {
    const { t } = useTranslation()
    const { moveTarget, renameTarget, deleteProjectTarget } = history
    const renamedTo = history.renameName.trim()

    return (
        <>
            <Modal
                isOpen={history.isCreateProjectOpen}
                onClose={history.closeCreateProject}
                title={t('conversation.conversationHistory.newProjectTitle')}
                maxWidth="26rem"
            >
                <form
                    className={styles.projectForm}
                    onSubmit={e => {
                        e.preventDefault()
                        history.submitCreateProject()
                    }}
                >
                    <InputTextWithHint
                        placeholder={t('conversation.conversationHistory.projectNamePlaceholder')}
                        value={history.newProjectName}
                        onChange={e => history.setNewProjectName(e.target.value)}
                        autoFocus
                        data-testid="new-project-name-input"
                    />
                    <button
                        type="submit"
                        className={styles.projectPrimaryBtn}
                        disabled={!history.newProjectName.trim() || history.isCreatingProject}
                        data-testid="new-project-create-btn"
                    >
                        {history.isCreatingProject
                            ? t('conversation.conversationHistory.creatingProject')
                            : t('conversation.conversationHistory.createProject')}
                    </button>
                </form>
            </Modal>

            <Modal
                isOpen={renameTarget != null}
                onClose={history.closeRenameProject}
                title={t('conversation.conversationHistory.renameProjectTitle')}
                maxWidth="26rem"
            >
                <form
                    className={styles.projectForm}
                    onSubmit={e => {
                        e.preventDefault()
                        history.submitRenameProject()
                    }}
                >
                    <InputTextWithHint
                        placeholder={t('conversation.conversationHistory.projectNamePlaceholder')}
                        value={history.renameName}
                        onChange={e => history.setRenameName(e.target.value)}
                        autoFocus
                        data-testid="rename-project-name-input"
                    />
                    <button
                        type="submit"
                        className={styles.projectPrimaryBtn}
                        disabled={!renamedTo || renamedTo === renameTarget?.name || history.isRenamingProject}
                        data-testid="rename-project-save-btn"
                    >
                        {history.isRenamingProject
                            ? t('conversation.conversationHistory.savingProjectName')
                            : t('conversation.conversationHistory.saveProjectName')}
                    </button>
                </form>
            </Modal>

            <Modal
                isOpen={moveTarget != null}
                onClose={() => history.setMoveTarget(null)}
                title={t('conversation.conversationHistory.moveToProjectTitle')}
                maxWidth="26rem"
            >
                {moveTarget != null && (
                    <div className={styles.projectPicker}>
                        {history.projects.length === 0 ? (
                            <p className={styles.pickerHint}>
                                {t('conversation.conversationHistory.noProjectsYet')}
                            </p>
                        ) : (
                            <ul className={styles.projectOptions}>
                                {history.projects.map(project => (
                                    <li key={project.projectId}>
                                        <button
                                            className={styles.projectOption}
                                            onClick={() => history.moveToProject(moveTarget, project)}
                                            disabled={project.projectId === moveTarget.projectId}
                                            data-testid={`move-to-project-${project.projectId}`}
                                        >
                                            <Icon src={ICONS.FOLDER} size={14} aria-hidden={true} />
                                            <span className={styles.projectOptionName}>{project.name}</span>
                                            {project.projectId === moveTarget.projectId && (
                                                <span className={styles.projectOptionCurrent}>
                                                    {t('conversation.conversationHistory.currentProject')}
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {moveTarget.projectId && (
                            <button
                                className={styles.projectSecondaryBtn}
                                onClick={() => history.removeFromProject(moveTarget)}
                                data-testid="remove-from-project-btn"
                            >
                                {t('conversation.conversationHistory.removeFromProject')}
                            </button>
                        )}
                    </div>
                )}
            </Modal>

            <DeleteConfirmModal
                isOpen={history.deleteTarget != null}
                title={t('conversation.conversationHistory.deleteConversationTitle')}
                message={t('conversation.conversationHistory.deleteConversationConfirm')}
                isDeleting={history.isDeleting}
                error={history.deleteError}
                onConfirm={history.confirmDelete}
                onCancel={history.cancelDelete}
                data-testid="delete-conversation"
            />

            <DeleteConfirmModal
                isOpen={deleteProjectTarget != null}
                title={t('conversation.conversationHistory.deleteProjectTitle')}
                message={t('conversation.conversationHistory.deleteProjectConfirm', { name: deleteProjectTarget?.name ?? '' })}
                isDeleting={history.isDeletingProject}
                error={history.deleteProjectError}
                onConfirm={history.confirmDeleteProject}
                onCancel={history.cancelDeleteProject}
                data-testid="delete-project"
            />
        </>
    )
}
