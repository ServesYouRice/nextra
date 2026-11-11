check 15 (C-c0da00822c45): no_change_needed. Checked on lane/libmisc at 1be0088; no file changed, nothing committed.

- Verdict: the claim does not hold. Below 1280px the expanded OBS card is capped at 46rem (736px) with `overflow: clip` and a border-box `clip-path`, as the report says. But its natural height never reaches the cap at the widths the report names. At 320-414px it is 358-624px, and at the 900-1279px tier, where the card is 19rem wide, it is 412-624px. The worst case is 320px wide (or the 19rem card) on a viewport at least 1440px tall, with the optional "Disabled for public sharing" hint: 624px, 112px under the cap.
- The report's mechanism is off. The 640px rule that turns `.setting-row-inline` into one column does nothing to this card: `.settings-panel .setting-row-inline` (src/index.css 630-634) has higher specificity and already stacks its only inline row (WS password) at every width. Hint wrapping at 320-400px is about the same as at the 304px card of the 900-1279px tier, where the "541px" note was measured.
- How measured: the lane built with `vite build --outDir` into my scratchpad, served by server.js on 3210 with NODE_ENV=test, NEXTRA_SMOKE_TEST=1 and NEXTRA_TEST_DIST_DIR, while I held the Playwright lock. Measurements used Playwright's Chromium: rendered height, computed max-height, a hit test of #obsPassword, and natural height with max-height lifted. Cases covered:
  - 19 widths from 320 to 1279, at heights 800, 932, 1440 and 2000, in desktop and isMobile contexts;
  - phone page zoom: 360, 390 and 412px phones at 125, 150, 175 and 200%;
  - browser default font of 20 and 24px;
  - WCAG 1.4.12 text-spacing overrides.

  Each case was measured with and without the extra hint. Afterwards the server was stopped and the lock released. Scripts and raw output are in C:\Users\V\AppData\Local\Temp\claude\c--Users-V-arbitra\53025464-426b-4472-9c62-52c45e3849f5\scratchpad (libmisc-check15-measure.cjs/.txt, libmisc-check15-natural.cjs, libmisc-check15-zoom.txt, libmisc-check15-textspacing.txt).
- Original code: same result. Since ac1c688 the index.css diff touches only the :root stage tokens, .video-container, .watch-video and one comment, and the settings-wrapper JSX in HostView.jsx is unchanged. The card's width, content, cap and clip are therefore the same as on the audited code.
- Residual fragility, for the owner. A fixed cap plus clip means any future growth past 46rem would be cut with no scroll. Today that happens only outside the claim and below the README's 320px floor:
  - a CSS viewport about 180-195px wide (200% page zoom on a 360-390px phone): about 10px of bottom padding cut, or 138px including the password row at 180x400 with the public-share hint;
  - a 24px browser default font in a 320px-wide window: 47px cut at 320x800 with the hint;
  - text spacing at 320x1440 with the hint: 12.5px, inside the padding.

  If rows are added to the card, re-measure, or replace the max-height reveal with one that does not need a guessed cap.
- Unrelated observation, not fixed, not in this check: at a 320px viewport with OBS ingest selected, the host video section, the start button and the capture-settings rows lay out 316px wide. They extend to x=332, so the page is 12px wider than the viewport (documentElement.scrollWidth 332). With OBS off it is 320. The existing reflow test at 320px does not select OBS, so it does not catch this.
