# T08 — UI correctness, accessibility, and support truth

Depends on T03, T04, T07, and decision D05.

<goal>
Fix the high-traffic state/copy/semantic defects and make support claims match
retained browser evidence.
</goal>

<read>
`src/WatchView.jsx`, `src/HostView.jsx`, `src/App.jsx`, `src/HowToView.jsx`,
`src/index.css`, browser tests, and relevant `README.md` sections.
</read>

<do>
1. Render a state-backed joined room code; update it on join/rejoin/reset.
2. Say the Watch button appears when media starts; do not promise autoplay.
3. Recommend an available 1080p/30 fps action instead of nonexistent 720p.
4. Give the room-code input a visible associated label, hint/error links, and
   invalid/busy state. Keep passphrase anti-enumeration behavior.
5. Set a useful title per hash route and focus/announce user-initiated route
   changes without stealing focus on initial load.
6. Expose 30/60 fps as a labelled group with programmatic selected state.
7. Implement D05: use feature detection and a tested role/path matrix; avoid
   user-agent gates and broad “any modern browser” or WCAG claims.
8. Add semantic tests plus representative 320/375/640/900/wide keyboard/reflow cases.
</do>

<accept>
State, copy, labels, routes, and selection semantics have focused tests; keyboard
flows work; UI and README claims do not exceed recorded browser/path evidence.
</accept>
