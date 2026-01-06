import React from 'react'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import styles from './UserAvatarButton.module.scss'

interface UserAvatarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    displayName: string
    displayPicture?: string
    'data-testid'?: string
}

export const UserAvatarButton: React.FC<UserAvatarButtonProps> = ({
    displayName,
    displayPicture,
    className = '',
    'data-testid': testId,
    ...props
}) => {
    return (
        <button
            className={`${styles.avatarButton} ${className}`}
            title={displayName}
            data-testid={testId}
            {...props}
        >
            {displayPicture ? (
                <img
                    src={displayPicture}
                    alt={displayName}
                    className={styles.avatarImage}
                    data-testid={testId ? `${testId}-image` : 'user-avatar-image'}
                />
            ) : (
                <Icon src={ICONS.USER_CIRCLE} size={40} data-testid={testId ? `${testId}-icon` : undefined} />
            )}
        </button>
    )
}
