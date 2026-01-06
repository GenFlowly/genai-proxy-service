// src/components/common/Icon/Icon.tsx
import React from 'react'

interface IconProps extends React.HTMLAttributes<HTMLSpanElement> {
    src: string
    alt?: string
    size?: string | number
    className?: string
}

export const Icon = ({ src, alt, size = "1em", className, ...props }: IconProps) => (
    <span
        className={className}
        style={{
            display: 'inline-block',
            width: size,
            height: size,
            backgroundColor: 'currentColor',
            maskImage: `url(${src})`,
            WebkitMaskImage: `url(${src})`,
            maskSize: 'contain',
            WebkitMaskSize: 'contain',
            maskRepeat: 'no-repeat',
            WebkitMaskRepeat: 'no-repeat',
            maskPosition: 'center',
            WebkitMaskPosition: 'center',
            flexShrink: 0
        }}
        role="img"
        aria-label={alt || 'icon'}
        {...props}
    />
)
