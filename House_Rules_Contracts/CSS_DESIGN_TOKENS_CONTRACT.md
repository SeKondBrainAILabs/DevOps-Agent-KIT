# CSS & Design Tokens Contract

**Last Updated:** 2026-02-19
**Version:** 1.0.0
**Status:** Initial Template

---

## Purpose

This contract documents **all styles, themes, design tokens, and CSS conventions** in the project. Coding agents **MUST check this file before creating new styles** to:
- Reuse existing design tokens instead of hardcoding values
- Maintain visual consistency across all components
- Avoid duplicate or conflicting CSS definitions
- Ensure theme support (light/dark mode)
- Prevent CSS specificity conflicts

---

## Change Log

| Date | Version | Agent/Author | Changes | Impact |
|------|---------|--------------|---------|--------|
| 2026-02-19 | 1.0.0 | DevOps Agent | Initial template creation | N/A - Template only |

---

## Design System Overview

### Technology Stack

| Property | Value | Notes |
|----------|-------|-------|
| **CSS Framework** | Tailwind CSS | Utility-first CSS |
| **Component Styling** | Tailwind classes + CSS modules | Per-component styles |
| **Theme System** | CSS custom properties + Tailwind config | Light/dark mode support |
| **Icon Library** | [Library name] | [Version] |
| **Font Stack** | [Primary font], [Fallback font] | System fonts preferred |

---

## Color Palette

### Brand Colors

| Token Name | Light Mode | Dark Mode | Usage |
|------------|------------|-----------|-------|
| `--color-primary` | `#[hex]` | `#[hex]` | Primary actions, links |
| `--color-primary-hover` | `#[hex]` | `#[hex]` | Primary hover state |
| `--color-secondary` | `#[hex]` | `#[hex]` | Secondary actions |
| `--color-accent` | `#[hex]` | `#[hex]` | Highlights, badges |

### Semantic Colors

| Token Name | Light Mode | Dark Mode | Usage |
|------------|------------|-----------|-------|
| `--color-success` | `#[hex]` | `#[hex]` | Success states, confirmations |
| `--color-warning` | `#[hex]` | `#[hex]` | Warning states, caution |
| `--color-error` | `#[hex]` | `#[hex]` | Error states, destructive actions |
| `--color-info` | `#[hex]` | `#[hex]` | Informational states |

### Surface Colors

| Token Name | Light Mode | Dark Mode | Usage |
|------------|------------|-----------|-------|
| `--color-bg-primary` | `#[hex]` | `#[hex]` | Main background |
| `--color-bg-secondary` | `#[hex]` | `#[hex]` | Card/panel backgrounds |
| `--color-bg-tertiary` | `#[hex]` | `#[hex]` | Nested/inset backgrounds |
| `--color-border` | `#[hex]` | `#[hex]` | Default borders |
| `--color-border-hover` | `#[hex]` | `#[hex]` | Hover state borders |

### Text Colors

| Token Name | Light Mode | Dark Mode | Usage |
|------------|------------|-----------|-------|
| `--color-text-primary` | `#[hex]` | `#[hex]` | Primary text |
| `--color-text-secondary` | `#[hex]` | `#[hex]` | Secondary/muted text |
| `--color-text-tertiary` | `#[hex]` | `#[hex]` | Placeholder text |
| `--color-text-inverse` | `#[hex]` | `#[hex]` | Text on dark backgrounds |

---

## Typography

### Font Scale

| Token Name | Size | Line Height | Weight | Usage |
|------------|------|-------------|--------|-------|
| `--font-xs` | 12px | 16px | 400 | Labels, captions |
| `--font-sm` | 14px | 20px | 400 | Body text (compact) |
| `--font-base` | 16px | 24px | 400 | Default body text |
| `--font-lg` | 18px | 28px | 500 | Subheadings |
| `--font-xl` | 20px | 28px | 600 | Section headings |
| `--font-2xl` | 24px | 32px | 700 | Page headings |
| `--font-3xl` | 30px | 36px | 700 | Hero text |

### Font Weights

| Token | Weight | Usage |
|-------|--------|-------|
| `--font-normal` | 400 | Body text |
| `--font-medium` | 500 | Emphasized text |
| `--font-semibold` | 600 | Headings, buttons |
| `--font-bold` | 700 | Page titles |

### Monospace / Code

| Token | Font | Usage |
|-------|------|-------|
| `--font-mono` | `'JetBrains Mono', 'Fira Code', monospace` | Code blocks, terminal output |
| `--font-mono-size` | 13px | Inline code, diffs |

---

## Spacing Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--space-0` | 0px | No spacing |
| `--space-1` | 4px | Tight spacing (icon gaps) |
| `--space-2` | 8px | Compact spacing (between related items) |
| `--space-3` | 12px | Default spacing |
| `--space-4` | 16px | Section padding |
| `--space-5` | 20px | Card padding |
| `--space-6` | 24px | Section gaps |
| `--space-8` | 32px | Large section gaps |
| `--space-10` | 40px | Page-level spacing |
| `--space-12` | 48px | Hero sections |

---

## Border & Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 4px | Badges, tags |
| `--radius-md` | 8px | Buttons, inputs |
| `--radius-lg` | 12px | Cards, panels |
| `--radius-xl` | 16px | Modals, dialogs |
| `--radius-full` | 9999px | Circular elements, pills |
| `--border-width` | 1px | Default border width |

---

## Shadows

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle elevation |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, dropdowns |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, popovers |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Dialogs |

---

## Z-Index Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--z-base` | 0 | Default stacking |
| `--z-dropdown` | 10 | Dropdowns, tooltips |
| `--z-sticky` | 20 | Sticky headers, sidebars |
| `--z-overlay` | 30 | Overlays, backdrop |
| `--z-modal` | 40 | Modals, dialogs |
| `--z-toast` | 50 | Toast notifications |
| `--z-tooltip` | 60 | Tooltips (above modals) |

---

## Component Patterns

### Button Variants

| Variant | Classes / Tokens | Usage |
|---------|------------------|-------|
| Primary | `bg-primary text-white` | Main actions |
| Secondary | `bg-secondary text-primary` | Alternative actions |
| Ghost | `bg-transparent text-primary` | Tertiary actions |
| Danger | `bg-error text-white` | Destructive actions |
| Disabled | `opacity-50 cursor-not-allowed` | Inactive state |

### Input Styles

| State | Border | Background | Text |
|-------|--------|------------|------|
| Default | `--color-border` | `--color-bg-primary` | `--color-text-primary` |
| Focus | `--color-primary` | `--color-bg-primary` | `--color-text-primary` |
| Error | `--color-error` | `--color-bg-primary` | `--color-text-primary` |
| Disabled | `--color-border` | `--color-bg-tertiary` | `--color-text-tertiary` |

### Status Indicators

| Status | Color Token | Icon | Usage |
|--------|-------------|------|-------|
| Active | `--color-success` | Circle (filled) | Running agents, connected |
| Warning | `--color-warning` | Triangle | Degraded, behind remote |
| Error | `--color-error` | Circle (X) | Crashed, disconnected |
| Idle | `--color-text-tertiary` | Circle (outline) | Inactive, pending |

---

## Animation & Transitions

| Token | Value | Usage |
|-------|-------|-------|
| `--transition-fast` | `150ms ease` | Hover states, toggles |
| `--transition-normal` | `250ms ease` | Panel opens, fades |
| `--transition-slow` | `400ms ease` | Page transitions |

### Motion Rules
- Prefer `transform` and `opacity` for animations (GPU-accelerated)
- Respect `prefers-reduced-motion` media query
- No animations on initial page load
- Maximum animation duration: 500ms

---

## Responsive Breakpoints

| Token | Width | Usage |
|-------|-------|-------|
| `--bp-sm` | 640px | Small devices |
| `--bp-md` | 768px | Tablets |
| `--bp-lg` | 1024px | Desktops |
| `--bp-xl` | 1280px | Large desktops |
| `--bp-2xl` | 1536px | Ultra-wide |

**Note:** Kanvas is an Electron desktop app. Breakpoints are used for responsive panel sizing, not device targeting. Minimum window size is 900x600.

---

## Theme Configuration

### Tailwind Config Tokens

**File:** `tailwind.config.js` (or `tailwind.config.ts`)

All design tokens MUST be defined in the Tailwind config, not inline:

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        // Map design tokens here
      },
      spacing: {
        // Map spacing scale here
      },
      // ...
    },
  },
};
```

### CSS Custom Properties

**File:** `renderer/styles/globals.css` (or equivalent)

```css
:root {
  /* Light mode tokens */
  --color-primary: #...;
  --color-bg-primary: #...;
}

[data-theme="dark"] {
  /* Dark mode overrides */
  --color-primary: #...;
  --color-bg-primary: #...;
}
```

---

## Notes for Coding Agents

### CRITICAL RULES:

1. **ALWAYS check this contract before adding new styles**
2. **USE design tokens** — never hardcode color hex values, pixel sizes, or shadows
3. **REUSE existing component patterns** — don't create new button/input styles
4. **FOLLOW the spacing scale** — use token values, not arbitrary pixels
5. **SUPPORT both themes** — every color must work in light and dark mode
6. **UPDATE this contract** after adding new tokens or patterns
7. **CROSS-REFERENCE:**
   - `tailwind.config.js` for token definitions
   - `renderer/styles/` for global CSS
   - `FEATURES_CONTRACT.md` for component requirements
8. **NEVER use `!important`** unless overriding third-party library styles

### Common Mistakes to Avoid:

- Using `#3b82f6` instead of `bg-primary` or `var(--color-primary)`
- Using `margin: 13px` instead of a spacing token
- Creating a new button variant when an existing one works
- Adding inline styles instead of Tailwind classes
- Using `z-index: 9999` instead of the z-index scale

---

## Initial Population Instructions

**For DevOps Agent / Coding Agents:**

1. **Extract Tailwind config:**
   - Read `tailwind.config.js` / `tailwind.config.ts`
   - Document all custom theme extensions

2. **Scan global CSS files:**
   - Read `renderer/styles/` directory
   - Extract CSS custom properties
   - Document theme variables

3. **Audit component styles:**
   - Identify recurring patterns (buttons, inputs, cards)
   - Document as component patterns above

4. **Check for hardcoded values:**
   - Search for inline hex colors: `#[0-9a-f]{3,6}`
   - Search for inline pixel values in component files
   - Flag for migration to design tokens

**Search Patterns:**
- Tailwind config: `tailwind.config.*`
- Global styles: `renderer/styles/**/*.css`
- Component styles: `renderer/components/**/*.css`
- Inline styles: `style={{` in `.tsx` files
- CSS modules: `*.module.css`

---

*This contract is a living document. Update it with every design system change.*
