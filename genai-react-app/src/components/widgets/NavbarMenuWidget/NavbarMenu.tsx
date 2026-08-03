import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import styles from './NavbarMenu.module.scss';

export const NAV_ITEMS = [
    { id: 'chat', label: 'Chat', path: '/chat' },
    { id: 'memory', label: 'Memory', path: '/memory' },
    { id: 'agents', label: 'Agents', path: '/agents' },
    { id: 'instructions', label: 'Instructions', path: '/instructions' },
];

export const NavbarMenu: React.FC = () => {
    const location = useLocation();

    return (
        <div className={styles.navLinks} data-testid="navbar-menu">
            {NAV_ITEMS.map((item) => {
                const isActive = location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path));
                return (
                    <Link
                        key={item.id}
                        to={item.path}
                        className={`${styles.navLink} ${isActive ? styles.activeNavLink : ''}`}
                        data-testid={`navbar-item-${item.id}`}
                    >
                        {item.label}
                    </Link>
                );
            })}
        </div>
    );
};
