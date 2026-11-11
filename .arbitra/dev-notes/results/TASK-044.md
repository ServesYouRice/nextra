TASK-044 (lane lifecycle, commit d53c17f on lane/lifecycle): scripts/opensource-preflight.js now matches .env files at any depth (.env.example exempt by basename at any depth), lists files with `git ls-files -z`, and classifies each tracked path as text, binary, directory or unreadable; an unreadable or missing tracked path is a violation. scanTrackedFiles takes an optional root and is exported with classifyTrackedPath, classifyTrackedFile and parseTrackedFileList. All steps of the prompt applied.

Checks: tests/opensourcePreflight.test.js 15/15 (12 new; the 11 that exercise the new behaviour failed on the unchanged code, 2 of them end to end through the script in a temp git repo, which printed OK). Full `npm test`: 783 tests, 0 failures. `npm run lint`, `npm run typecheck` pass. `node scripts/opensource-preflight.js` exits 0.

Step 5 (tracked files that would newly fail): none. The only tracked .env-style file is the root `.env.example`, which stays exempt; all 248 tracked files are readable regular files, none has a non-ASCII or whitespace name, and there is no gitlink.

Notes for the owner:
- A tracked gitlink (submodule) whose directory is absent from the working tree is reported as "Cannot read tracked file ... (ENOENT)": from `git ls-files` alone it cannot be told apart from a deleted file. The repository has no gitlinks. An initialised or empty checked-out submodule directory is skipped.
- A tracked file deleted from the working tree but not yet from the index is now a violation too, as the prompt asks.
- Added `maxBuffer` (256 MB) to the `git ls-files -z` call: the Node default of 1 MB would make a very large listing look like "not a git repository".
- The `.env.example` exemption stays case-sensitive (as before); `.ENV.EXAMPLE` is still blocked by the case-insensitive rule.
- Prompt's "path classifier" was read as a function classifying a tracked path as 'forbidden-file' | 'forbidden-pattern' | 'allowed' (classifyTrackedPath); the file classifier returns an object `{ kind, text | code }`.
