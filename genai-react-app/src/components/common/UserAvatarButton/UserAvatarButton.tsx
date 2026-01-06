import React from 'react'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import styles from './UserAvatarButton.module.scss'

interface UserAvatarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    displayName: string
    displayPicture?: string
}

export const UserAvatarButton: React.FC<UserAvatarButtonProps> = ({
    displayName,
    displayPicture,
    className = '',
    ...props
}) => {
    return (
        <button
            className={`${styles.avatarButton} ${className}`}
            title={displayName}
            {...props}
        >
            {displayPicture ? (
                <img
                    src={displayPicture}
                    alt={displayName}
                    className={styles.avatarImage}
                    data-testid="user-avatar-image"
                />
            ) : (
                <Icon src={ICONS.USER_CIRCLE} size={40} />
            )}
        </button>
    )
}
