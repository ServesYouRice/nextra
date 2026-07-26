# T01 — Reproducible dependencies

Depends on nothing; this is the entry card.
Findings: CF-01.

<goal>
Regenerate the malformed root lockfile with the CI Node 20 toolchain, then make
the installed tree and clean-install gates match `package.json`.
</goal>

<read>
`package.json`, `package-lock.json`, `.github/workflows/ci.yml`,
`.github/workflows/release.yml`, and `poc-mediasoup/package.json`.
</read>

<do>
1. Record `node --version` and `npm --version`. Use Node 20; do not generate the
   shipping lock with the currently observed Node 22 environment.
2. Regenerate the root lockfile from `package.json` in a clean disposable Node 20
   environment. Do not hand-repair line 2403 or change declared ranges.
3. Review the full lock diff for unrelated major upgrades, native mediasoup
   artifacts, integrity fields, platform packages, and the `minimatch` override.
4. Run a clean `npm ci`, then `npm ls --depth=0`. Fix only dependency or lint
   failures that reproduce on this clean graph.
5. Align the two pinned `actions/setup-node` revisions in CI.
</do>

<accept>
- Both lockfiles parse; the clean install and dependency inventory succeed on Node 20.
- Every listed check passes.
- No unrelated application change or dependency upgrade is included.
</accept>

<checks>
`npm ci`, `npm ls --depth=0`, `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build`, `npm run evaluate:packaging`, `npm run oss:check`, and
`npm run audit:prod`.
</checks>

<stop>
Block on registry/native-package failure, a required major upgrade, or an audit
finding that needs a risk decision. Include the exact package and command output.
</stop>
