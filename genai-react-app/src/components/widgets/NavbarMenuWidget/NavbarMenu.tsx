import React from 'react';
import { Link, useLocation } from 'react-router';
import styles from './NavbarMenu.module.scss';
import { useLayout } from '../../../context/LayoutContext';

export const NAV_ITEMS = [
    { id: 'chat', label: 'Chat', path: '/chat' },
    { id: 'memory', label: 'Memory', path: '/memory' },
    { id: 'agents', label: 'Agents', path: '/agents' },
    { id: 'instructions', label: 'Instructions', path: '/instructions' },
];

export const isNavItemActive = (pathname: string, itemPath: string): boolean =>
    pathname === itemPath || (itemPath !== '/' && pathname.startsWith(itemPath));

export const NavbarMenu: React.FC = () => {
    const location = useLocation();
    const { setLeftSidebarExpanded } = useLayout();

    const handleLinkClick = () => {
        setLeftSidebarExpanded(false);
    };

    return (
        <div className={styles.navLinks} data-testid="navbar-menu">
            {NAV_ITEMS.map((item) => {
                const isActive = isNavItemActive(location.pathname, item.path);
                return (
                    <Link
                        key={item.id}
                        to={item.path}
                        className={`${styles.navLink} ${isActive ? styles.activeNavLink : ''}`}
                        data-testid={`navbar-item-${item.id}`}
                        onClick={handleLinkClick}
                    >
                        {item.label}
                    </Link>
                );
            })}
        </div>
    );
};
