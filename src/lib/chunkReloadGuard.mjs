// Persisted reload budget for chunk-load recovery. The budget lives in sessionStorage so it survives the
// page reloads it allows; only window expiry resets it (never app mount). Fails closed: any storage problem
// returns false, so no automatic reload happens and the error reaches the app's error handling.

export const CHUNK_RELOAD_STORAGE_KEY = 'nextra:chunkReloadBudget';

function readBudget(storage, storageKey) {
  const raw = storage.getItem(storageKey);
  if (raw === null || raw === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { count, firstAt } = parsed;
  if (!Number.isInteger(count) || count < 0) return null;
  if (typeof firstAt !== 'number' || !Number.isFinite(firstAt)) return null;
  return { count, firstAt };
}

export function createChunkReloadGuard({
  storage,
  now,
  maxReloads = 2,
  windowMs = 60000,
  storageKey = CHUNK_RELOAD_STORAGE_KEY,
} = {}) {
  return {
    tryConsumeReload() {
      try {
        if (!storage) return false;
        const t = now();
        let budget = readBudget(storage, storageKey);
        if (!budget || t < budget.firstAt || t - budget.firstAt >= windowMs) {
          budget = { count: 0, firstAt: t };
        }
        if (budget.count >= maxReloads) return false;
        storage.setItem(storageKey, JSON.stringify({ count: budget.count + 1, firstAt: budget.firstAt }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
