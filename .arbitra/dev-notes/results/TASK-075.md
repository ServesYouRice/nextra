# TASK-075

Chunk-load reload budget persisted in sessionStorage, reset only by window expiry. Guard in src/lib/chunkReloadGuard.mjs, wired in src/main.jsx; 12 tests added. Not run: npm run build (needs owner approval per the prompt; lane dist is a link to the main checkout). Prompt cross-references VAL-145/146/147 and VAL-106 were stale; the applicable checks are VAL-161 to VAL-163 (Q-075-STORAGE default fail-closed applied; answers.md does not override it).
