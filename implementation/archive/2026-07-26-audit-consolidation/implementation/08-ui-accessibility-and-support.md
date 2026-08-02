# Packet 08 - UI correctness, accessibility, and supported-browser truth

Findings: CF-16, CF-17, CF-18. Prerequisites: Packets 01, 03, and 05 for final copy.

## Objective

Fix high-traffic semantic/copy defects and make browser/mobile claims match
retained evidence. Prefer truthful explicit interaction over untested autoplay.

## Read first

- `src/WatchView.jsx`, `src/HostView.jsx`, `src/App.jsx`, `src/HowToView.jsx`
- shared form/status components and relevant `src/index.css`
- browser tests and any accessibility tooling established after Packet 01
- merged UI entries in `audits-codex/consolidated-findings.md`

## A. Viewer and Host correctness

1. Add state-backed `joinedRoomCode`; update it on join/rejoin/reset and render it
   instead of reading `joinedRoomCodeRef.current` during render.
2. Change waiting copy to say the Watch button appears when the host starts. Do
   not implement background autoplay unless a separate gesture/autoplay design
   and cross-browser test is approved.
3. Change congestion advice to an available action (normally 1080p/30 fps). Add
   720p only after bitrate/quality validation, not as part of this copy fix.
4. Integrate Packet 05 terminal/restart text without duplicating banners.

## B. Core accessibility semantics

1. Give the room-code field a visible label (`Room code or watch link`), associate
   its hint/error, and expose invalid/busy state.
2. Map each hash route to a useful document title. On user navigation, announce
   or focus the route heading/main landmark without stealing focus on initial load.
3. Make live 30/60 fps a labelled radio/toggle group with selected state
   (`aria-pressed` or native radio semantics) and visible focus.
4. Add automated semantic tests for the form, route/title/focus transition, and
   selected frame-rate state. Retain keyboard and screen-reader manual evidence.

## C. Support scope

Create a role/path matrix based on actual tests, not user-agent assumptions:

- host capture: supported desktop Chromium variants and system-audio limits;
- viewer direct WebRTC: tested Chromium/Firefox/WebKit scope;
- browser WebM relay: MSE/container support;
- OBS H.264 fMP4 relay and AV1 WebRTC-only path;
- iOS/iPadOS/mobile layout and feature-detection results.

Add friendly capability messages at view load/failure and update How-To/README.
Replace “any modern browser” with the proven matrix. Test 320/375/640/900/wide
layouts, zoom/reflow, keyboard, reduced motion, and representative failure states.

## Invariants

- Do not leak room existence/passphrase protection through a new preflight.
- Do not gate capability solely by user-agent strings.
- Do not promise auto-start, mobile, Safari, or WCAG support without evidence.
- Preserve existing focus trap, skip link, reduced-motion, and aria-live behavior.
- Validate the alleged OBS status live-region miss manually before changing it.

## Acceptance criteria

- Joined room label is state-backed and clean lint passes.
- Waiting and bandwidth copy describe actions users can actually take.
- Primary input, route change, and frame-rate selection have tested semantics.
- Support docs/UI match the retained browser/path matrix.
- Core flows remain usable by keyboard at representative viewports.

## Dispatch objective

```xml
<objective>
Fix the state-backed room label and truthful wait/bandwidth copy; add accessible
room-code, route title/focus, and frame-rate-selection semantics with tests; then
replace broad browser/mobile claims with a capability-tested role/path matrix and
friendly feature-detection guidance. Do not add untested autoplay or user-agent gates.
</objective>
```
