# T09 — Relay security and bounded operations

Depends on T02, T05, and decision D02.

<goal>
Apply the chosen LAN relay policy, bound long-lived housekeeping collections,
and remove avoidable hidden-tab/absent-host work.
</goal>

<read>
HTTP/TLS and relay configuration, `server.js`, Status UI polling, Host metrics,
`config.js`, `.env.example`, tests, and operations/security text in `README.md`.
</read>

<do>
1. Implement D02 with the smallest config/UI gate. State plainly that Socket.IO
   relay payloads are plaintext on HTTP; WebRTC DTLS does not cover them.
2. Expire `cloudflareTurnMintByIp` entries after their window and clear them at
   shutdown. Clear `ignoredTransportIds` on global/socket cleanup.
3. Stop Status polling while hidden; on visibility refresh immediately and start
   exactly one interval. Abort obsolete requests.
4. Skip fixed Host metric pushes when no Host can receive them.
5. Attach owners/error handling to known floating promises. Treat a truly
   unexpected `unhandledRejection` as fatal under the documented supervisor
   contract instead of continuing in unknown state; test/log the shutdown reason.
6. Add fake-clock/cleanup/visibility tests for bounded state and timer ownership.
7. Add concise guidance for quick-tunnel local `--no-tls-verify`, readiness/worker/
   relay/tunnel alerts, log rotation/redaction, capability URLs, and credential storage.
</do>

<accept>
Collections remain bounded, hidden tabs do no periodic work, resume creates one
timer, absent hosts get no metrics work, unexpected rejection handling is
supervisor-safe, and relay/security wording is accurate.
</accept>
