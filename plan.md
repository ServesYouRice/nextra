# Nextra UI Audit & Modernization Plan

Date: 2026-07-02
Branch: `claude/ui-audit-modernization-5zza2b`

## 1. Audit summary

### 1.1 Current UI surface

| Route | View | State |
|---|---|---|
| `#` (default) | `Landing` (inline in `App.jsx`) | Sparse two-card page, no hero/branding, no feature overview |
| `#host` | `HostView.jsx` (1,796 lines) | Feature-rich but 45 inline `style={{}}` blocks, hardcoded hex colors, ad-hoc layout |
| `#watch` / `#watch/CODE` | `WatchView.jsx` (1,355 lines) | Works, but status/warning banners are inline-styled one-offs |
| `#how-to` | `HowToView.jsx` | Long article; references CSS variables that do not exist (`--surface-3`, `--accent-1`) so callouts render transparent |
| `#privacy` | `PrivacyView.jsx` | Fine content-wise, plain presentation |
| `#copyright` | `CopyrightView.jsx` | Fine content-wise, plain presentation |
| anything else | Falls through to `Landing` silently | No 404 page |

### 1.2 Implemented features with **missing pages/UI**

1. **Server status & metrics — no page.** `GET /api/metrics` (server.js:693) returns active rooms, viewer/relay/WHEP counts, mediasoup consumer counts, and socket runtime metrics, with local/remote token auth. Nothing in the UI consumes it. → Add a **`#status` dashboard page** with auto-refresh and graceful handling of 401/403 for remote clients.
2. **WHEP egress — invisible to hosts.** `/whep/watch/:roomCode` (lib/whepRoutes.js) lets external WHEP players (OBS, GStreamer, web players) watch a room; the host UI even counts WHEP viewers, but the WHEP playback URL is never shown anywhere. → Surface the **WHEP URL (with copy) in the host streaming panel** when `whepEnabled`, and document it in How-To.
3. **No 404 page.** Unknown hash routes silently render the Landing page. → Add a **NotFound view** with links back to Home/Host/Watch.
4. **No crash surface.** A render error white-screens the app (only chunk-load errors are recovered in `main.jsx`). → Add a top-level **React ErrorBoundary** with a reload affordance.
5. **Landing page undersells implemented features.** OBS/WHIP, AV1, relay fallback, public tunnel links, remote media control, 4K60 — none mentioned. → Rebuild Landing as a proper hero + feature grid using README's feature list.

### 1.3 Outdated / substandard patterns to fix

- **Inline styling everywhere**: 45 inline style objects in `HostView` alone, one-off hex colors (`#e5a84b`, `#2a2a3e`, `#0d0d1a`, `#3a1a1a`…) bypassing the design tokens.
- **Broken CSS variables** in `HowToView` (`var(--surface-3)`, `var(--accent-1)` are undefined).
- **Render-blocking external font** via CSS `@import` of Google Fonts → move to preconnected `<link>` tags in `index.html` with `display=swap`.
- **Accessibility gaps**:
  - Copyable room code / links are plain `<span onClick>` — not focusable, no keyboard access, no `role="button"`.
  - Status changes (`Copied!`, connect states) are not announced (`aria-live` missing).
  - BYOK TURN modal has no focus management; nav lacks `aria-current`; no visible `:focus-visible` styles; no skip link.
  - No `prefers-reduced-motion` handling despite pulse/slide/blur animations.
- **Layout/CSS modernization**: `min-height: 100vh` → `100dvh`, `color-scheme: dark`, `accent-color`, logical properties for nav/footer padding, `text-wrap: balance` on headings, consistent spacing scale, mobile nav overflow.
- **UX polish**: plain-text "Loading..." Suspense fallback → skeleton/spinner; alerts get icons + roles (`role="alert"`); consistent status pills instead of colored `<div>`s; buttons get proper disabled/loading states.

### 1.4 Explicit non-goals (risk containment)

- **No changes to the media pipeline logic**: mediasoup/WebRTC/relay/OBS-WebSocket flows in `HostView`, `WatchView`, `src/lib/*` stay behaviorally identical. Only render/JSX/presentation layers are reworked.
- No router library swap (hash routing stays — required by share links `/#watch/CODE`).
- No server behavior changes; only read-only consumption of existing endpoints (`/api/metrics`, `/api/config`).
- No new runtime dependencies.

## 2. Implementation approach

### Phase 1 — Design system refresh (`src/index.css`, `index.html`)
- Reorganized token set (surfaces, text, semantic status colors, spacing radii, transitions), `color-scheme: dark`, focus-visible rings, reduced-motion media query, `100dvh`.
- Replace CSS `@import` fonts with preloaded `<link>` in `index.html`.
- New reusable primitives: status pills, copy fields, code blocks, callouts, skeleton loader, feature cards, stat cards — replacing today's one-off inline styles.

### Phase 2 — Shared components (`src/components/`)
- `CopyField.jsx` — accessible copy-to-clipboard row (button semantics, `aria-live` feedback). Replaces all click-to-copy spans.
- `StatusPill.jsx` — semantic status indicator (ok/warn/error/info + optional pulse dot).
- `Modal.jsx` — dialog wrapper with Escape handling, backdrop click, focus restore (used by BYOK TURN modal).
- `ErrorBoundary.jsx` — top-level crash screen.

### Phase 3 — Shell & navigation (`App.jsx`)
- Header: `aria-current` nav, active styles, skip-to-content link, Status link.
- Proper 404 route + `NotFound.jsx`; better Suspense fallback.
- Rebuilt Landing: hero (brand, tagline), Host/Watch action cards, feature grid from the implemented feature set.

### Phase 4 — Page remakes (presentation only)
- **HostView**: strip all inline styles into semantic classes; restructure the streaming info area (room code, links, viewer stats, OBS WHIP setup) into cleaner card sections; add WHEP URL row (from `/api/config` `whepEnabled` + room code); keep every hook/callback/effect untouched.
- **WatchView**: replace inline warning/status blocks with alert/pill components; tidy join form and controls; logic untouched.
- **HowToView**: fix broken CSS vars, restyle callouts with the new system, add a short "External players (WHEP)" section.
- **Privacy/Copyright**: adopt the refreshed article styles (no content rewrites).

### Phase 5 — New Status page (`#status`)
- `StatusView.jsx`: fetches `/api/metrics` with 5s auto-refresh; totals row (rooms, viewers, relay, WHEP, consumers), per-room table, socket runtime stats; friendly error state for remote/unauthorized clients (403/401) and unreachable server.

### Phase 6 — Verification
- `npm run lint`, `npm test`, `npm run build` all green.
- Manual smoke pass over each route in the built app (dev server) to check layout, keyboard navigation, and reduced-motion behavior.

### Commit strategy
Small, reviewable commits per phase (plan → design system → components → shell/landing → host/watch → docs/legal → status page → fixes), pushed to the designated branch.
