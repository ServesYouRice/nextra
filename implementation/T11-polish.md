# T11 — Small polish and extraction

Depends on T01–T10, so it inherits every open decision. Execute one bullet per
change; this card never authorizes a broad Host/Watch/socket rewrite.
Findings: CF-23, CF-24.

<goal>
Clear the low-priority copy, semantic, and duplication debt in independently
reviewable batches, without changing behavior outside each item.
</goal>

<read>
Only the files named by the item you are executing, plus their existing tests.
</read>

<do>
- Make passphrase-required an informational second step that preserves the code
  and focuses the labelled field without revealing room protection early.
- Map known capture/timeout/transport/abort failures to a useful action while
  retaining technical detail separately.
- Track fullscreen state and pressed semantics, or remove the redundant control.
- Correct Status-token copy; do not describe a token UI that does not exist.
- Consolidate duplicate 400 px CSS blocks with viewport assertions.
- Change OBS live-region markup only if a retained assistive-technology test fails.
- Deduplicate `formatBytes`, room metrics payloads, fMP4 eviction, and URL parsing
  only after behavior tests cover both existing call sites.
- Extract relay/reconnect lifecycle ownership one seam at a time; every extraction
  names timer/listener/resource ownership and proves idempotent cleanup.
</do>

<accept>
Each change is independently reviewable, has a focused regression, preserves
behavior outside its item, and passes the full relevant browser/release gates.
</accept>

<checks>
Run the focused test for the item, then `npm test` and `npm run test:e2e`.
</checks>

<stop>
If an item lacks a reproducer or prerequisite behavior test, leave it parked.
Do not add protocol schemas until clients and servers can deploy independently.
</stop>

<parked>
Require a new user card before building: path-specific Host preflight, redacted
diagnostic bundle, measured capacity/headroom, named-tunnel onboarding, viewer
copy-link, clearer room/link lifetime, and configurable support/legal contacts.
</parked>
