import React, { ElementType, HTMLAttributes } from 'react'
import { ICONS } from '../../../constants/icons'
import { Icon } from '@genflowly/component-library'
import styles from './BrandName.module.scss'

// --- Generic BrandName Component ---
// Vendor logos were removed from the app: full brand names render as plain
// text, and collapsed contexts show an initial badge ("C" for Claude, ...).
interface BrandNameProps<T extends ElementType = 'div'> extends HTMLAttributes<HTMLElement> {
    name: string
    as?: T
}

export default function BrandName<T extends ElementType = 'div'>({
    name,
    as,
    className = '',
    ...props
}: BrandNameProps<T> & React.ComponentPropsWithoutRef<T>): React.ReactElement {
    const Component = as || 'div'

    return (
        <Component className={`${styles.brandContainer} ${className}`} {...props} data-testid="brand-name-container">
            <span data-testid="brand-name-text">{name}</span>
        </Component>
    )
}

// --- Specific Implementations ---

export function OpenAIBrandName<T extends ElementType = 'div'>(props: Omit<BrandNameProps<T>, 'name'> & React.ComponentPropsWithoutRef<T>) {
    return <BrandName name="OpenAI" {...props} />
}

export function ClaudeBrandName<T extends ElementType = 'div'>(props: Omit<BrandNameProps<T>, 'name'> & React.ComponentPropsWithoutRef<T>) {
    return <BrandName name="Claude" {...props} />
}

export function GeminiBrandName<T extends ElementType = 'div'>(props: Omit<BrandNameProps<T>, 'name'> & React.ComponentPropsWithoutRef<T>) {
    return <BrandName name="Gemini" {...props} />
}

// --- Collapsed variants: vendor initial badge ---

interface CollapsedInitialProps {
    initial: string
    name: string
    size?: number
    className?: string
    'data-testid'?: string
}

function CollapsedInitial({ initial, name, size = 20, className, 'data-testid': testId }: CollapsedInitialProps) {
    return (
        <span
            className={`${styles.collapsedInitial} ${className || ''}`}
            style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.75)) }}
            role="img"
            aria-label={name}
            title={name}
            data-testid={testId}
        >
            {initial}
        </span>
    )
}

export function CollapsedOpenAIBrandName({ size = 30, className }: { size?: number, className?: string }) {
    return <CollapsedInitial initial="O" name="OpenAI" size={size} className={className} data-testid="collapsed-openai-brand" />
}

export function CollapsedClaudeBrandName({ size = 20, className }: { size?: number, className?: string }) {
    return <CollapsedInitial initial="C" name="Claude" size={size} className={className} data-testid="collapsed-claude-brand" />
}

export function CollapsedGeminiBrandName({ size = 20, className }: { size?: number, className?: string }) {
    return <CollapsedInitial initial="G" name="Gemini" size={size} className={className} data-testid="collapsed-gemini-brand" />
}

export function UserBrandName<T extends ElementType = 'div'>({
    name,
    picture,
    as,
    className = '',
    ...props
}: {
    name: string;
    picture?: string;
    as?: T;
    className?: string;
} & Omit<React.ComponentPropsWithoutRef<T>, 'className' | 'children' | 'as'>) {
    const Component = as || 'div'

    return (
        <Component className={`${styles.brandContainer} ${className}`} {...props} data-testid="user-brand-name-container">
            {picture ? (
                <img
                    src={picture}
                    alt={name}
                    style={{
                        width: '1.5rem',
                        height: '1.5rem',
                        borderRadius: '50%',
                        objectFit: 'cover',
                        flexShrink: 0
                    }}
                />
            ) : (
                <Icon src={ICONS.USER_CIRCLE} size={24} />
            )}
            <span data-testid="user-brand-name-text">{name}</span>
        </Component>
    )
}
