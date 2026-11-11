TASK-027 (lane lifecycle, at dev 1733678): no production change needed; commit bdc8624 adds a route-level test.

- The defect (passive offer answered a=setup:passive while mediasoup is connected as DTLS client) was already fixed by check 17 (a863cb6): `viewerDtlsRoles` in lib/whep.js returns `{ remoteRole, answerSetup }` from one decision, `parseViewerDtls` and `createViewerAnswer` both use it, and `buildActiveSection` writes `answerSetup` into every answered section. The prompt's lines 195 and 373 are gone.
- What was still open is the prompt's step 2 / VAL-036 evidence: a test of the argument `transport.connect()` actually receives from the route together with the returned SDP. Check 17's tests call `parseViewerDtls` and `createViewerAnswer` directly; `tests/whepRoutesSession.test.js` covers the route only for actpass.
- New file `tests/whepRoutesDtlsRole.test.js` (own harness, no shared helper or existing test touched): real `createWhepRouter` over a fake transport recording `connect()`. Cases: actpass, active and passive at session level and per media section, no a=setup, and video/audio disagreeing (video decides). Each asserts the remote role and every a=setup line.
- Checked against the pre-fix `lib/whep.js` (`git show a863cb6^:lib/whep.js`, restored afterwards): 2 of 5 fail (passive; disagreeing sections), the actpass, active and no-setup cases pass in both versions. Output: `lifecycle-TASK-027-before.txt` in the shared scratchpad.
- lint, typecheck, `node --test tests/whep.test.js` (121) and `npm test` (1290) pass.

Prompt corrections:
- The prompt's defect is stale (see above); TASK-026's note about VAL-145 is the only wrong id, and this prompt cites none.
- It names tests/whep.test.js for the new tests; I used a new file because the `connect()` argument is only visible through lib/whepRoutes.js, and a new file cannot conflict with TASK-025's edits to whep.test.js.
- Left open (as check 17 already noted): `a=setup:holdconn` is answered passive.
