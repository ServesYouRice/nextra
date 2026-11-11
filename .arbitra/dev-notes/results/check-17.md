- [x] check 17 `C-dd67f45071b6` Hardcoded DTLS setup:passive in WHEP answer causes handshake deadlock when viewer offers passive: **fixed** (the claim holds in part; lane `netcheck`, at dev 109f819, commit a863cb6)

  - What was wrong. `parseViewerDtls` passes remote role `'server'` to `transport.connect()` when the viewer offers
    `a=setup:passive` (`lib/whep.js:195`). `buildActiveSection` still always wrote `a=setup:passive` (`:531`). So
    the role mediasoup takes and the role the answer states were opposite.
  - What the claim gets wrong. It says both sides end up passive and neither sends a ClientHello. mediasoup is not
    passive here. Remote role `'server'` makes it the DTLS client, and it does send the ClientHello. The broken part
    is the answer: RFC 4145 section 4.1 allows only `active` (or `holdconn`) in an answer to a passive offer.
    - A viewer that follows the answer also becomes DTLS client. Two clients means no handshake.
    - A strict viewer rejects the answer.
    - Only a viewer that ignores the answer's setup got through.
  - Who is affected. Browsers offer `actpass` (JSEP), so they never took this path. It hits non-browser WHEP clients
    that offer passive, a case the code was written to support (the role comment in `parseViewerDtls`). I did not
    run a browser; that browsers offer actpass comes from the standard, not from a run here.
  - Check with real mediasoup: `results/check-17-dtls-probe.js.txt`, output in `results/check-17-probe-output.txt`.
    - The probe starts a mediasoup 3.27.1 worker and a WebRtcTransport. It connects the transport with the
      `parseViewerDtls` role, as `lib/whepRoutes.js` does. It completes ICE with a hand-built STUN binding request
      and watches what mediasoup sends.
    - Passive offer: local role `client`, ClientHello sent (5 packets, with retransmits), answer said `passive`.
    - actpass, active, no setup: local role `server`, nothing sent (it waits for the viewer), answer `passive`. That
      answer was correct.
    - `lib/whep.js` from ac1c688 gave the same output, so the original code had the defect too. The two lines
      the claim names are the same there (`parseViewerDtls`, and `a=setup:passive` at line 373).
    - After the fix the passive offer gets `a=setup:active`, which matches mediasoup's client role. The other
      answers are unchanged.
  - Fix (`lib/whep.js` only). A new helper, `viewerDtlsRoles(parsedOffer)`, not exported, returns
    `{ remoteRole, answerSetup }`:
    - `passive` gives `'server'` / `active`.
    - Anything else (actpass, active, absent, holdconn) gives `'client'` / `passive`.
    - It reads the setup from the section `parseViewerDtls` takes the fingerprint from (video, else audio), and
      ignores case.
    - `parseViewerDtls` takes its role from the helper. `createViewerAnswer` computes `answerSetup` once and passes
      it to `buildActiveSection`, which has one new last parameter. Every answered section carries the one value.
      This is the same shape as TASK-033's `dtlsRoles` in `lib/whip.js`.
  - Tests: `tests/whep.test.js`, new describe `WHEP answer a=setup matches the DTLS role given to mediasoup`, 9
    tests, placed after the `parseViewerDtls` block. 4 failed on the unchanged code:
    - the session-level and media-level passive cases;
    - an upper-case `PASSIVE` (the old code gave role `client`);
    - video passive with audio actpass (the old answer said passive in both sections).
    - The actpass, active and no-setup cases pass before and after.
    - No existing test changed.
  - Checks: `node --test tests/whep.test.js` 121/121. `npm run lint` and `npm run typecheck` pass. `npm test`
    1060/1060.
  - Choices I made:
    - The setup is now read case-insensitively. The old code compared it case-sensitively, but RFC 5234 ABNF
      strings are case-insensitive, and the WHIP side (TASK-033) already does it this way.
    - When video and audio disagree, video decides for both sections. They share one bundled transport and one
      DTLS role. A disagreement is not rejected.
  - For the whep lane (TASK-025): `buildActiveSection` has one new last parameter, `answerSetup`. Its call in
    `createViewerAnswer` passes it, and the `a=setup` line uses it. Nothing else in the function changed.
  - Left open: `a=setup:holdconn` is still answered passive. RFC 4145 would answer holdconn, but no WHEP client is
    known to send it.
