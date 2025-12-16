# Theming System

This application supports both light and dark themes that automatically adapt to the system preference.

## How It Works

### 1. Theme Detection
- **On first load**: The app detects the system's color scheme preference using `window.matchMedia('(prefers-color-scheme: dark)')`
- **Saved preference**: If the user manually toggles the theme, their choice is saved in `localStorage`
- **System changes**: The app automatically updates when the system theme changes (unless user has set a manual preference)

### 2. Architecture

#### Theme Files
- **`/src/styles/themes.scss`**: Contains all CSS variables for both themes
  - Light theme variables in `:root`
  - Dark theme variables in `[data-theme="dark"]`
  - SCSS variable mappings for backward compatibility

#### Theme Context
- **`/src/context/ThemeContext.tsx`**: React context that manages theme state
  - Provides `theme`, `setTheme`, and `toggleTheme` functions
  - Handles localStorage persistence
  - Listens to system theme changes

#### Theme Toggle Component
- **`/src/components/common/ThemeToggle/ThemeToggle.tsx`**: Button to manually switch themes
  - Shows 🌙 for light mode (click to go dark)
  - Shows ☀️ for dark mode (click to go light)

### 3. Using Theme Variables

#### In SCSS Files
Always import the themes file and use CSS variables:

```scss
@import '../../../styles/themes.scss';

.myComponent {
  background: $color-background;
  color: $color-text-primary;
  border: 1px solid $color-border;
}
```

#### Available Theme Variables

**Colors:**
- `$color-primary`, `$color-primary-hover`, `$color-primary-light`
- `$color-success`, `$color-success-hover`
- `$color-background`, `$color-background-secondary`, `$color-background-tertiary`
- `$color-text-primary`, `$color-text-secondary`, `$color-text-muted`
- `$color-border`, `$color-border-light`, `$color-border-focus`

**Shadows:**
- `$shadow-sm`, `$shadow-md`, `$shadow-lg`, `$shadow-focus`

**Sidebar:**
- `$color-sidebar-background`, `$color-sidebar-button`

**Disabled States:**
- `$color-disabled`, `$color-disabled-text`

### 4. Adding the Theme Toggle

Add the ThemeToggle component to your navbar or settings:

```tsx
import ThemeToggle from '../common/ThemeToggle/ThemeToggle'

// In your component
<ThemeToggle />
```

### 5. Migrating Existing Components

To migrate a component to use themes:

1. Change import from `variables.scss` to `themes.scss`:
   ```scss
   @import '../../../styles/themes.scss';
   ```

2. Replace hardcoded colors with theme variables:
   ```scss
   // Before
   background: #ffffff;
   color: #1c1c1c;
   
   // After
   background: $color-background;
   color: $color-text-primary;
   ```

### 6. Updating Theme Colors

To change the color palette:

1. Open `/src/styles/themes.scss`
2. Update the CSS variable values in `:root` (light theme) and `[data-theme="dark"]` (dark theme)
3. All components using those variables will automatically update

## Current Theme Colors

### Light Theme
- Primary: `#007aff` (iOS blue)
- Success: `#28a745` (green)
- Background: `#ffffff` (white)
- Text: `#1f2937` (dark gray)

### Dark Theme
- Primary: `#0a84ff` (brighter blue)
- Success: `#32d74b` (iOS green)
- Background: `#1c1c1e` (iOS dark)
- Text: `#ffffff` (white)

## Best Practices

1. ✅ **Always use theme variables** instead of hardcoded colors
2. ✅ **Import `themes.scss`** instead of `variables.scss` in new components
3. ✅ **Test both themes** when adding new UI elements
4. ✅ **Use semantic variable names** (e.g., `$color-text-primary` not `$dark-gray`)
5. ❌ **Don't** hardcode hex colors in component styles
6. ❌ **Don't** use inline styles with hardcoded colors
