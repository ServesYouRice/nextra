TASK-033 (lane whip, branch lane/whip): one helper in lib/whip.js, dtlsRoles(parsedOffer), reads the offer's a=setup from the section parseDtlsParameters uses (video, else audio) and returns { remoteRole, answerSetup }: passive -> 'server' / active; active, actpass, absent or any other value -> 'client' / passive. parseDtlsParameters takes its role from it and createAnswer writes `a=setup:${answerSetup}` once for every answered section. The helper is not exported. Changed files: lib/whip.js, tests/whip.test.js. 16 new tests (9 failed before the fix; the other 7 are the actpass and absent cases and the actpass golden, which pass before and after). Full npm test 767/767; lint and typecheck pass.

Prompt notes:
- "VAL-145" is the forwarded-header assertion; the setup assertion is VAL-148 (VAL-043 is right). Worked to VAL-043 and VAL-148.
- The line numbers were stale (TASK-020/021/022 moved createAnswer). The setup line was inside buildMediaSection, which the restructured serializer calls only for accepted sections, so rejected sections still carry no a=setup.
- The prompt mentions "the escalation below" for a=setup:holdconn, but the prompt has no escalation text and questions.md has no holdconn question. Default used: holdconn (or any value other than passive) is treated like an absent setup, so remote role 'client' and answer passive. The comparison is case-insensitive.
- The "actpass answer matches the previous output" test holds a golden list of lines captured from the unchanged serializer (ignoring the o= line); it passed before and after the fix.
- Q-004 (section-f0767a79379636e542689295) and its later correction: this task owns the WHIP a=setup line, as the prompt says; nothing else changed it.

Left open: when the video and audio sections of one offer disagree on setup, the video section (the one parseDtlsParameters uses) decides for every answered section; this is tested but a disagreement is not rejected.
