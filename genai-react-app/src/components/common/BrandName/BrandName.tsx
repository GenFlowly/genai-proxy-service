import React, { ElementType, HTMLAttributes } from 'react'
import { ICONS } from '../../../constants/icons'
import { Icon } from '../Icon/Icon'
import styles from './BrandName.module.scss'

// --- Generic BrandName Component ---
interface BrandNameProps<T extends ElementType = 'div'> extends HTMLAttributes<HTMLElement> {
    icon: string
    name: string
    as?: T
    iconSize?: number
}

export default function BrandName<T extends ElementType = 'div'>({
    icon,
    name,
    as,
    iconSize = 20,
    className = '',
    ...props
}: BrandNameProps<T> & React.ComponentPropsWithoutRef<T>): React.ReactElement {
    const Component = as || 'div'

    return (
        <Component className={`${styles.brandContainer} ${className}`} {...props}>
            <Icon src={icon} size={iconSize} />
            <span>{name}</span>
        </Component>
    )
}

// --- Specific Implementations ---

export function OpenAIBrandName<T extends ElementType = 'div'>(props: Omit<BrandNameProps<T>, 'icon' | 'name'> & React.ComponentPropsWithoutRef<T>) {
    return <BrandName icon={ICONS.OPENAI} name="OpenAI" iconSize={30} {...props} />
}

export function ClaudeBrandName<T extends ElementType = 'div'>(props: Omit<BrandNameProps<T>, 'icon' | 'name'> & React.ComponentPropsWithoutRef<T>) {
    return <BrandName icon={ICONS.CLAUDE} name="Claude" iconSize={20} {...props} />
}

export function GeminiBrandName<T extends ElementType = 'div'>(props: Omit<BrandNameProps<T>, 'icon' | 'name'> & React.ComponentPropsWithoutRef<T>) {
    return <BrandName icon={ICONS.GEMINI} name="Gemini" iconSize={20} {...props} />
}
