TASK-105 (lane watch): the Vite dev and preview servers no longer allow '.trycloudflare.com' unless VITE_ALLOW_QUICK_TUNNEL=true (compared lower-cased, so only the value true opts in), and both proxy entries (/api, /socket.io) set xfwd: true. lint, typecheck and `npm test` (860 tests, 0 failed) pass; `node --test tests/viteConfig.test.js` 6 of 6.

Prompt notes:
- The prompt's step 3 says to call configFn with the flag "with and without"; the test also covers other flag values (false, 1, yes, on, 0 stay off), SHARE_BASE_URL/EXTRA_ALLOWED_ORIGINS without the flag, the flag together with SHARE_BASE_URL, and the LOCAL_HTTPS target on the proxy entries.
- loadEnv(mode, cwd, '') lets process.env override .env files, so the test sets the four variables the config reads (including LOCAL_HTTPS) to an empty string, calls the config from an empty temporary directory, and restores both afterwards. A mode with no .env.<mode> file is used as the prompt says.
- Added no README or .env.example text for VITE_ALLOW_QUICK_TUNNEL (outside the allowed files; neither mentions the dev tunnel host today). The flag is documented in the vite.config.mjs comment only. Owner may want a line in README's dev section.
- xfwd only helps when the backend trusts forwarded headers (TRUST_X_FORWARDED_HEADERS=true with a loopback peer, TRUST_PROXY hop count); with the default settings the backend still sees the loopback peer, as the issue says. Not changed, per the constraints.
- No real request through a running Vite server was made: the config hardcodes the backend at localhost:3000, which the main checkout may be using. `vite build` into the scratchpad loads the new config fine.
- vite.config.mjs and the new test are CRLF in the working copy (the index is LF), as the other files are.
