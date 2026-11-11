# Verifier comparison: Opus 5.5 against Sonnet 5.5 on nextra

Run `run-ccd3ccea` (Opus 5.5 verified every question) against the replay `run-98e2ee7a` (same discovery output,
Sonnet 5.5 as verifier, same medium effort). Truth comes from
`.arbitra/plans/2026-10-23-ccd3ccea/results.json`, the plan of `run-ccd3ccea` carried out.

Written October 24, 2026 from the two runs' artifacts under `C:\Users\V\arbitra-experiments\.runs\runs`
(`verification-results`, `canonical-issues`, `verification-operations`, `verification-second-opinion-*`).

## Totals

22 verdicts differ. Of those, 15 have a known truth (all 15 are in the plan) and 7 do not (Opus rejected them, so
they are not in the plan and none matches a plan issue).

Scoring: **right** is a definite verdict that agrees with the truth (confirmed for a real defect, rejected for one
that is not). **Wrong** is a definite verdict against the truth. **Unsettled** (`STILL_NEEDS_VERIFICATION`) is
neither; such an issue reaches the plan as a "check" item and is decided there. Check 07 counts as real, as
instructed; checks with `fixed` and a failing test (`failedBefore: true`) are real; `no_change_needed` is not real.

| Known truth | Cases | Opus right | Opus wrong | Opus unsettled | Sonnet right | Sonnet wrong | Sonnet unsettled |
|---|---|---|---|---|---|---|---|
| High | 4 | 2 | 0 | 2 | 0 | 2 | 2 |
| Medium | 11 | 4 | 0 | 7 | 6 | 1 | 4 |
| **All** | **15** | **6** | **0** | **9** | **6** | **3** | **6** |

Who was right, row by row: Opus 6 (2 high, 4 medium), Sonnet 6 (0 high, 6 medium), neither 3 (Sonnet made a wrong
call, Opus left it unsettled: check 05, check 07 high; check 18 medium).

Reading the two halves of the disagreement:

- **Where Opus was definite and Sonnet balked (6 cases, all real, all proven by a failing test):** Opus was right
  6 of 6 (2 high, 4 medium). Sonnet's unsettled verdict cost a check item instead of a task, but nothing was lost.
- **Where Opus could not settle and Sonnet gave an answer (9 cases):** Sonnet was right 6 of 9 (all medium: check
  11, 12, 16, 17, 19 real; check 20 not real) and wrong 3 of 9. The three wrong calls: check 05 (high) and check
  18 (medium) confirmed claims that do not hold, and check 07 (high) rejected a defect that was real, which would
  have dropped it from the plan with nothing to catch it. Both highs in this group went the wrong way.
- Sonnet's definite calls with a known truth: 6 right of 9 (67%); on highs, 0 of 2. Opus's: 6 right of 6.
- Confidence does not separate Sonnet's right and wrong calls: wrong 0.70 (05), 0.80 (07), 0.86 (18); right 0.78 to
  0.85.
- The 7 unknown cases (Opus rejected): Sonnet confirmed 3 and left 4 unsettled, all medium. They cannot be
  scored. The `TRUST_PROXY=1` one looks wrong on a reading of the current code (see the notes under the table) but
  the plan does not settle it.

The three cases already in the notes check out against the data: check 05 (Sonnet confirmed, not real), TASK-005
(Sonnet unsettled, real) and check 07 (Sonnet rejected, real). One difference in framing: the notes count
Sonnet's unsettled TASK-005 as "wrong"; here it is a missed call, not a wrong one, and 15 known cases give a fuller
picture than those 3 (Sonnet right 6, wrong 3, unsettled 6).

## Table

Severity is the same in both runs for all 22. "Plan item" is the item in `results.json`. Verdicts: confirmed,
rejected, unsettled; the number is the verifier's confidence.

### High (4)

| Issue | Opus | Sonnet | Plan item and result | Truth | Right |
|---|---|---|---|---|---|
| C-0114aaa7ba9b Asynchronous startup can publish a superseded session | confirmed 0.70 | unsettled 0.60 | TASK-036 fixed, failedBefore true | real | Opus |
| C-70eb68e12178 Trusted forwarded client IP is read from client-controllable headers (CF-Connecting-IP passthrough, leftmost X-Forwarded-For) | confirmed 0.70 | unsettled 0.70 | TASK-005 fixed, failedBefore true | real | Opus |
| C-d5509617e498 fMP4 parser discards ftyp on stream restart producing incomplete init segment | unsettled 0.60 | confirmed 0.70 | check 05 no_change_needed (restart resets the parser; claimed trigger never reaches that state) | not real | Neither: Sonnet wrong, Opus unsettled |
| C-16669fbfe3c8 OBS profile write and encoder listing are gated only by a 'loopback' check, which local cloudflared tunnels may satisfy | unsettled 0.60 | rejected 0.80 (auditor-b second opinion also rejected, 0.98) | check 07 no_change_needed, but "held at audit time, removed by TASK-053" | real (counted as real) | Neither: Sonnet wrong, Opus unsettled |

### Medium, truth known (11)

| Issue | Opus | Sonnet | Plan item and result | Truth | Right |
|---|---|---|---|---|---|
| C-1e6314bdf369 SSRC-less offers lose all RTP stream identifiers | confirmed 0.78 | unsettled 0.60 | TASK-035 fixed, failedBefore true | real | Opus |
| C-2ae13a6deb9f H.264 compatibility checks discard profile constraints and defaults | confirmed 0.80 | unsettled 0.60 | TASK-026 fixed, failedBefore true | real | Opus |
| C-740131c505fd Vite dev/preview proxy makes every proxied client look like loopback while public quick-tunnel hosts are allowlisted by default | confirmed 0.74 | unsettled 0.60 | TASK-105 fixed, failedBefore true | real | Opus |
| C-7a074ed76e89 Tunnel URL detection assumes pipe chunks contain complete URLs | confirmed 0.75 | unsettled 0.60 | TASK-029 fixed, failedBefore true | real | Opus |
| C-9c4be8de5969 A new relay generation mid-playback is appended to the existing SourceBuffer without abort() or changeType() | unsettled 0.55 | confirmed 0.78 | check 19 fixed, failedBefore true | real | Sonnet |
| C-bd7abbaa0e86 Cross-worker media-flow file lock leaks its ticket when beforeEach times out, deadlocking every later test | unsettled 0.55 | confirmed 0.85 | check 12 fixed, failedBefore true | real | Sonnet |
| C-d1826a7c4342 SPS/PPS are injected before every IDR slice, splitting multi-slice keyframes into separate access units | unsettled 0.60 | confirmed 0.80 | check 16 fixed by TASK-093, failedBefore true | real | Sonnet |
| C-dd67f45071b6 Hardcoded DTLS setup:passive in WHEP answer causes handshake deadlock when viewer offers passive | unsettled 0.60 | confirmed 0.80 | check 17 fixed, failedBefore true (defect real, mechanism differs from the claim) | real | Sonnet |
| C-e82bf68bcd5e Shutdown transport IDs are cleaned up through the wrong event emitter | unsettled 0.60 | confirmed 0.85 | check 11 fixed, failedBefore true | real | Sonnet |
| C-cd64e0d537f1 Unchecked property access on socket.handshake in getSocketIp | unsettled 0.55 | rejected 0.78 | check 20 no_change_needed (socket.io always builds handshake; the running server does not call getSocketIp) | not real | Sonnet |
| C-4723a43516b4 (Sonnet: C-7593bb03f6b0) Configuration rollback restarts OBS stream after setup failure | unsettled 0.55 | confirmed 0.86 | check 18 no_change_needed (the restart is the rollback restoring the user's earlier stream, by design) | not real | Neither: Sonnet wrong, Opus unsettled |

### Medium, truth unknown (7, all Opus-rejected, none in the plan)

| Issue | Opus | Sonnet | Plan item and result | Truth | Right |
|---|---|---|---|---|---|
| C-1b3aa84ee30b keyframeStart is true for every fragment that contains video, without checking sample sync flags | rejected 0.80 | confirmed 0.93 | none | unknown | unknown |
| C-69f9d038753a parseTrustProxy maps single-hop '1' to boolean true enabling IP spoofing | rejected 0.62 | confirmed 0.85 | none (see note 3) | unknown | unknown |
| C-a1860feb658a WHIP bearer token for OBS is sent over a hard-coded http:// URL regardless of the WHIP host | rejected 0.70 | confirmed 0.70 | none | unknown | unknown |
| C-5a27b05f4697 verifyRoomPassphrase returns mixed sync booleans and async Promises | rejected 0.80 | unsettled (see note 4) | none | unknown | unknown |
| C-813a3864dc55 Redacted operator token in room creation test causes deterministic test failure | rejected 0.85 | unsettled 0.70 | none | unknown | unknown |
| C-9c19dfb46f67 Live output patch omits the B-frame and header settings the stream-settings builder requires for WebRTC, and the two disagree on AV1 tune | rejected 0.60 | unsettled 0.60 | none | unknown | unknown |
| C-e638198dbf25 Failure in applyConsumerPriority leaks unclosed mediasoup consumer | rejected 0.72 | unsettled 0.55 | none | unknown | unknown |

## Matching and gaps

1. **Matching.** Both runs use the same candidate ids where the cluster is the same. 21 of the 22 differing
   verdicts are the same id in both runs with identical title and identical source findings. 176 of the 192
   questions Opus asked match by id; 12 more match by an identical title under a different id, which makes the 188
   issues of the notes. Those 12 agree except one, which is the 22nd differing verdict: Opus C-4723a43516b4 against
   Sonnet C-7593bb03f6b0 ("Configuration rollback restarts OBS stream after setup failure"). That pair is not
   like for like: Sonnet's candidate has two source findings, the extra one being the low-severity "Rollback
   restarts a previous stream even when it was only retrying a dead target", which Opus never verified (below
   plan scope). The truth (check 18) is for Opus's candidate; it also fits the extra finding's claim, which is the
   same restart.
2. **The replay did not reuse Opus's clustering.** The replay's artifacts hold 4 semantic-clustering calls, and 16
   of Opus's verified candidates have no same-id Sonnet counterpart (17 of Sonnet's have none in Opus). Four Opus
   candidates have no Sonnet candidate with the same title: C-6cf5d2b06b57, C-6d493af411aa, C-90a6cdbe1e70 and
   C-a6bfe7e35a4e. Their findings were merged into other Sonnet candidates, all confirmed by both, so none is
   among the 22. Sonnet also verified 193 questions against Opus's 192.
3. **C-69f9d038753a (TRUST_PROXY=1).** Not in the plan. Plan item TASK-004 (C-463b545aedba) is a different defect
   in the same function (addresses parsed as hop counts). A reading of nextra's current code, not a result:
   `config.js` line 84 still maps '1' to `true`; `resolveTrustedHopCount` in `lib/network.js` counts `true` as one
   hop, so the app's own identity code is not widened; and the only use of Express's `req.ip` is a log line
   (`server.js` line 1316). That supports the notes' view that Sonnet's confirmation is wrong, but it is not
   `results.json` evidence, so the truth stays unknown here.
4. **C-5a27b05f4697.** Sonnet's "unsettled" is not a verdict. Its question hit `MODEL_OUTPUT_LIMIT_REACHED`
   (128000 tokens), the run recorded it in `verification-unanswered`, and the result carries confidence 0. It is
   one of the 4 "left unsettled that Opus rejected" in the notes; on that line the true count of Sonnet judgments is 3.
5. **Check 07.** `results.json` records `no_change_needed` with failedBefore false, but its proof says the gate
   held at audit time and TASK-053 (40a7e0a) removed it; counted as real, as instructed. Sonnet's rejection was
   also upheld by a second opinion from auditor-b (GPT-6.1) at 0.98, so a second model did not catch the error.
6. **Truth is the plan's, not independent.** `fixed` with `failedBefore: true` means a failing test showed the
   defect. `no_change_needed` means an implementer read or ran the code and found the claim not to hold; for checks
   05, 18 and 20 the proofs give scripted evidence, and for 18 the proof says the mechanism is right but the
   defect is by design. Checks 16, 17 and 19 were fixed with the proofs noting the claim was partly off (effects
   overstated or a different mechanism); counted as real.
7. **Sample size.** 15 known cases, 4 high. The medium result (Sonnet 6 right, 1 wrong, 4 unsettled; Opus 4 right, 0
   wrong, 7 unsettled) rests on 11 cases; 7 more medium cases cannot be scored.
