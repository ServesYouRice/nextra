TASK-060 (C-1d64ecacf775): fixed on lane/watch.

- No DOM unit harness exists in the repo, so the proof is a Playwright test. The test opens the leave-host dialog while sharing (the AV1 TURN dialog cannot open under the e2e config: SHARE_BASE_URL makes the public share status 'manual', which disables the AV1 checkbox). A viewer joins the room and re-renders the host view; focus must stay on 'Leave and Stop'.
- Modal now holds onClose in a ref updated on every render; the focus/keydown effect runs once on mount and unmount.
- Verification: the e2e server was built with vite into the scratchpad and started by hand on port 3210 (reuseExistingServer). ui-semantics.spec.mjs: 41 passed, 7 skipped, exit 0. npm run lint and typecheck clean; npm test 500/500.
