import React, { ElementType, HTMLAttributes } from 'react'
import { ICONS } from '../../../constants/icons'
import { Icon } from '@genflowly/component-library'
import { useVendorDisplayNames } from '../../../hooks/useVendorDisplayNames'
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

// --- Vendor variants: name text comes from the provider catalog ---

export function VendorBrandName<T extends ElementType = 'div'>({
    vendorId,
    ...props
}: Omit<BrandNameProps<T>, 'name'> & { vendorId: string } & React.ComponentPropsWithoutRef<T>) {
    const displayName = useVendorDisplayNames()
    return <BrandName name={displayName(vendorId)} {...props} />
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

export function CollapsedVendorBrandName({ vendorId, size = 20, className }: { vendorId: string, size?: number, className?: string }) {
    const displayName = useVendorDisplayNames()
    const name = displayName(vendorId)
    return (
        <CollapsedInitial
            initial={name.charAt(0).toUpperCase()}
            name={name}
            size={size}
            className={className}
            data-testid={`collapsed-${vendorId.toLowerCase()}-brand`}
        />
    )
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
