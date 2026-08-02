# Development Guide: Adding a New Page

This guide outlines the exact steps required to create a new page in the application, map it to a URL route, add it to the navigation bar, and ensure the UI layout (like the Navbar) displays correctly.

## 1. Map the Page to a URL Route

The React application uses `react-router-dom` for routing. All route mappings are centrally managed in `AppContent.tsx`.

1. Open `src/AppContent.tsx`.
2. Import your new page component at the top of the file.
3. Add a new `<Route />` inside the `<Routes>` block. If the page requires authentication, wrap it in `<ProtectedRoute>`.

```tsx
// src/AppContent.tsx
import NewFeaturePage from './pages/NewFeaturePage/NewFeaturePage';

<Routes>
    ...
    <Route path="/new-feature" element={<ProtectedRoute><NewFeaturePage /></ProtectedRoute>} />
</Routes>
```

## 2. Include the Navbar on Your New Page

Because this app **does not use a global layout wrapper**, every individual top-level page component is responsible for rendering the `<Navbar />`. If you forget this step, your page will load without navigation.

1. Open your page component (e.g., `src/pages/NewFeaturePage/NewFeaturePage.tsx`).
2. Import the `Navbar` component.
3. Wrap your page content in a root `div` that uses a `.page` CSS class.
4. Render `<Navbar />` as the first child of the root `div`.

```tsx
// src/pages/NewFeaturePage/NewFeaturePage.tsx
import React from 'react';
import Navbar from '../../components/navbar/Navbar';
import styles from './NewFeaturePage.module.scss';

export default function NewFeaturePage() {
    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.pageContainer}>
                <h1>New Feature</h1>
                {/* Your page content */}
            </div>
        </div>
    );
}
```

5. In your SCSS module (e.g., `src/pages/NewFeaturePage/NewFeaturePage.module.scss`), define the `.page` class to ensure it handles the 100vh height and flex layout properly, matching the rest of the application:

```scss
// src/pages/NewFeaturePage/NewFeaturePage.module.scss
.page {
    height: 100vh;
    overflow: hidden;
    background-color: var(--color-background-primary, #ffffff);
    display: flex;
    flex-direction: column;
}

.pageContainer {
    padding: 2rem;
    height: 100%;
    overflow-y: auto;
    width: 100%;
}
```

## 3. Add the Page to the Navbar Tabs

If you want your new page to be easily accessible from the top navigation tabs (like "Chat", "Memory", "Agents"), you need to add it to the Navbar Menu widget.

1. Open `src/components/widgets/NavbarMenuWidget/NavbarMenu.tsx`.
2. Locate the `NAV_ITEMS` array.
3. Add a new object for your page with a unique `id`, a display `label`, and the `path` that matches what you set in `AppContent.tsx`.

```tsx
// src/components/widgets/NavbarMenuWidget/NavbarMenu.tsx
export const NAV_ITEMS = [
    { id: 'chat', label: 'Chat', path: '/chat' },
    { id: 'memory', label: 'Memory', path: '/memory' },
    { id: 'agents', label: 'Agents', path: '/agents' },
    { id: 'instructions', label: 'Instructions', path: '/instructions' },
    { id: 'new-feature', label: 'New Feature', path: '/new-feature' }, // <-- Added here
];
```

The Navbar will automatically detect if the user is on that path (or a sub-path) and highlight the tab appropriately.
