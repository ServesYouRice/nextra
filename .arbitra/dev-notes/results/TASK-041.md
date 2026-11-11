TASK-041 (lane scripts): the benchmark's /api/metrics requests now honor --allow-insecure-tls, using node:https with rejectUnauthorized per request (Q-007 default, no undici). Verify commands pass, lint, typecheck and npm test (504 tests) pass.

Prompt corrections: scripts/runtime-metrics-client.js and tests/benchmarkRuntime.test.js did not exist; both were created. Its first test fails on the unchanged code only because the module is missing, so the certificate failure was shown separately with a standalone fetch script.
