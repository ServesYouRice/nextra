'use strict';

class ExpiringTracker {
    constructor(windowMs, now = () => Date.now()) {
        this.windowMs = windowMs;
        this.now = now;
        this.entries = new Map();
    }

    hasActive(key) {
        const expiresAt = this.entries.get(key);
        if (!expiresAt) return false;
        if (expiresAt <= this.now()) {
            this.entries.delete(key);
            return false;
        }
        return true;
    }

    record(key) {
        this.entries.set(key, this.now() + this.windowMs);
    }

    prune() {
        const now = this.now();
        for (const [key, expiresAt] of this.entries) {
            if (expiresAt <= now) this.entries.delete(key);
        }
    }

    clear() {
        this.entries.clear();
    }

    get size() {
        return this.entries.size;
    }
}

module.exports = { ExpiringTracker };
