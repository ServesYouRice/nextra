# Executor task prompts

This directory contains one self-contained prompt per current Ready card. An
executor receives exactly one task file; it does not need conversation history,
an audit transcript, a template, or instructions from another task. Start a new
prompt from `TEMPLATE.md`.

## Routing

| Task | Model | Effort | Change type | Escalates when |
| --- | --- | --- | --- | --- |
| `T43-foundation-tokens.md` | `claude-sonnet-5-5` | `high` | Design change | An existing `ui-semantics` test fails (a box changed size), or the new grey fails 4.5:1 contrast |
| `T44-howto-sideways-scroll.md` | `claude-haiku-5-5` | — | Behavior fix | The new tests are not red first, or the page still scrolls sideways |
| `T45-start-error-reason.md` | `claude-sonnet-5-5` | `low` | Behavior fix | The new test is not red first, or a cancelled picker loses its advice |
| `T46-wrong-passphrase-feedback.md` | `claude-sonnet-5-5` | `medium` | Behavior fix | The new test is not red first, or the server answer would have to change |
| `T47-host-picture-stopped.md` | `claude-opus-5-5` | `high` | Behavior fix | The new test is not red first, or the picture does not return after Resume Sharing |
| `T48-host-copy-lines.md` | `claude-haiku-5-5` | — | Copy fix | A sentence is not where the prompt says, or a browser test asserts on the old wording |
| `T49-stage-sizes.md` | `claude-sonnet-5-5` | `medium` | Design change | A stage or fit-to-viewport test other than the listed one fails |
| `T50-ship-fonts.md` | `claude-sonnet-5-5` | `medium` | Design change | A font licence is not OFL-1.1, a font would load from another host, or the licence gate fails |
| `T51-shell-navigation.md` | `claude-sonnet-5-5` | `medium` | Design change | The bar cannot hold 44px targets within its height limit |
| `T52-home-page.md` | `claude-sonnet-5-5` | `medium` | Design change | A LANDING rule is used outside the home page, or the page scrolls sideways at 320px |
| `T53-host-source-tabs-start.md` | `claude-sonnet-5-5` | `high` | Design change | `#obsMode` cannot be checked as a radio, or a test beyond the three listed needs an edit |
| `T54-host-settings-panel.md` | `claude-sonnet-5-5` | `high` | Design change | Panel and preview edges cannot match within 1px, or the page scrolls at laptop sizes |
| `T55-host-obs-panel.md` | `claude-sonnet-5-5` | `high` | Design change | The rows do not fit 1280x720, or the grey-out would change what is sent to OBS |
| `T56-host-invite-card.md` | `claude-opus-5-5` | `high` | Design change | Any existing spec needs an edit, or a WHEP-enabled server does not show the player link |
| `T57-host-live-status-line.md` | `claude-sonnet-5-5` | `high` | Design change | The hidden `Streaming (` status is not found, or a test beyond the three listed needs an edit |
| `T58-host-obs-guided-steps.md` | `claude-opus-5-5` | `high` | Design change | Progress needs more than the one optional callback, or an OBS test fails |
| `T59-host-needs-computer.md` | `claude-sonnet-5-5` | `medium` | Design change | A `mobile-chrome` test lands on the new message |
| `T60-viewer-join-card.md` | `claude-sonnet-5-5` | `high` | Design change | The code field stops being fillable, or a test beyond the two listed lines needs an edit |
| `T61-viewer-one-step-join.md` | `claude-opus-5-5` | `high` | Design change | A pinned source count would change, another test needs the two-step gap, or sound arrives only some of the time |
| `T62-viewer-picture-controls.md` | `claude-opus-5-5` | `high` | Design change | A faded control cannot be pressed, or the picture cannot fill the window without scrolling |
| `T63-viewer-states.md` | `claude-opus-5-5` | `high` | Design change | The last frame cannot be drawn, or two alerts would show at once |
| `T64-status-page.md` | `claude-sonnet-5-5` | `medium` | Design change | The metrics request cannot be answered by the test, or a number has no place |
| `T65-howto-page.md` | `claude-sonnet-5-5` | `high` | Design change | A renamed label does not match the source, or the security test fails |
| `T66-phone-tap-targets.md` | `claude-sonnet-5-5` | `medium` | Behavior fix | The new spec is not red first, or a control needs a markup change to reach 44px |
| `T67-type-radius-sweep.md` | `claude-sonnet-5-5` | `medium` | Design change | A layout test passes only with a padding or height change, or a size off the scale is needed |

## Execution contract

1. Read only the assigned prompt, then the source files listed in its `<files>`
   block.
2. Inspect current code before editing and stay inside the prompt's file scope.
3. Follow ordered red-test steps exactly for behavior-fix cards.
4. For a tests-only card, stop and report if an expectation fails; do not change
   production source or relax the assertion.
5. Run every command in `<verification>` in order. Report only checks actually
   run in the current session.
6. Return the prompt's `<report_format>` and stop. Do not start another task or
   edit `../KANBAN.md`.
