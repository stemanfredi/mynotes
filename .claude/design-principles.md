# mynotes — Design Principles

The source of truth for UI/UX review. There are no Figma files; **this document is
the design**. When Claude reviews or changes the UI, it grades against this doc.

## Ethos

**"Less is more," and the filesystem is the product.** mynotes is a deliberately
minimal "Obsidian for the web": a folder of plain Markdown files with a thin editor
in front. The UI should feel like a quiet, fast text tool — not an app with chrome.
Every pixel of UI that isn't the user's text is a cost. Prefer removing UI over
adding it. No spinners-as-decoration, no gratuitous animation, no onboarding.

## Layout

- Three columns: **left sidebar (note tree) · center (editor) · right (backlinks)**.
- Desktop baseline: `230px / 1fr / 230px` grid.
- The center column is sacred: editor content is capped at **760px**, left-aligned
  at a fixed 2rem margin (the top-bar title shares that edge), with generous
  padding, for comfortable line length.
- The left bar pins the search/＋ row; only the note list scrolls.

## Responsive behavior (REQUIRED)

The app must be usable down to **375px**. Target three viewports:

| Width  | Expectation |
|--------|-------------|
| 1440px | Full three-column layout. |
| 768px  | Right (backlinks) panel collapses or moves; two-column max. Editor stays readable. |
| 375px  | Single column. Sidebar becomes a toggleable drawer/overlay, not a 230px column squeezing the editor to nothing. No horizontal scroll. Tap targets ≥ 36×36px. |

No element may cause horizontal overflow at any width.

## Color & theme

- Theme follows the OS via `color-scheme` + `light-dark()` — **no JS, no media-query
  toggles**. Keep it that way.
- All colors come from the `:root` custom properties in `styles.css`
  (`--bg --panel --border --fg --muted --accent --hover --active --embed`). Never
  hard-code a hex outside that block except deliberate one-offs (e.g. the delete-red).
- Accent is the only chromatic color; everything else is neutral.

## Typography

- System font stack (`--font`); editor at 15px; UI text 0.75–0.9rem.
- One type scale for headings (h1 1.7em → h6 0.9em), already defined as `.cm-pv-h*`.
- Monospace (`ui-monospace, …`) only for code.

## Spacing

- Base rhythm in rem multiples of ~0.25 (`.25 / .35 / .4 / .5 / .75 / 1rem`).
- Rounded corners 4–6px. Borders are 1px `--border`. No drop shadows.

## Interaction

- **Single-click** opens a note / toggles a folder; **double-click** renames inline.
- Search box doubles as quick-create (Enter on a non-match creates the note).
- Saves are debounced and silent; the only feedback is the `#status` text
  (`editing…` / `saved` / `new note` / conflict message).
- Drag a row onto a folder to move it; drop on empty space to move to root.

## Accessibility bar — WCAG 2.1 AA (REQUIRED — currently unmet)

This is a hard requirement, not aspirational. Every change is graded on:

1. **Keyboard:** every interactive element is reachable and operable by keyboard
   (Tab/Shift-Tab/Enter/Space/Esc). Today sidebar rows, the chevron, the delete
   "×", and rendered `[[wikilinks]]` are `<span>`s with mouse-only handlers — that
   must change (use real `<button>`/`role` + `tabindex`, key handlers).
2. **Visible focus:** every focusable element has a clear, non-color-only focus ring.
3. **Semantic HTML / ARIA:** lists are lists, buttons are buttons. The note tree
   should expose `role="tree"`/`treeitem` semantics or equivalent. Icon-only controls
   (the ＋ button, the ×) need accessible names.
4. **Live regions:** `#status` changes must be announced — wrap in `aria-live="polite"`.
5. **Labels:** the title input and search input need programmatic labels.
6. **Contrast:** text meets **4.5:1** (3:1 for large text) against its background in
   both light and dark themes. `--muted` on `--panel`/`--bg` is the prime suspect —
   verify, don't assume.
7. **No native `confirm()`-only flows** that trap keyboard/screen-reader users
   awkwardly; if kept, ensure it's reachable and the trigger is a real button.

## Non-goals

Mobile-app polish, theming UI, settings screens, live collaboration cursors,
loading skeletons. If a change adds any of these, it's out of scope.

## Severity rubric (for reviews)

- **[Blocker]** Broken layout, data-loss risk, or a keyboard/contrast failure that
  makes a core flow unusable.
- **[High]** Significant UX/a11y problem; should fix before merge.
- **[Medium]** Noticeable but non-blocking; fix soon.
- **[Nitpick]** Polish. Prefix with `Nit:`.
