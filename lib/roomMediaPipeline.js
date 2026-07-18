'use strict';

class RoomMediaPipeline {
    constructor(room, { onClose } = {}) {
        if (!room) throw new TypeError('RoomMediaPipeline requires a room.');
        this.room = room;
        this.state = 'idle';
        this.generation = 0;
        this._resources = new Map();
        this._whipResources = new Map();
        this._onFallbackClose = typeof onClose === 'function' ? onClose : null;
        this._closed = false;
    }

    beginStart({ onClose } = {}) {
        if (this._closed) throw new Error('Room media pipeline is closed.');
        if (this.state !== 'idle') return null;
        if (typeof onClose === 'function') this._onFallbackClose = onClose;
        this.state = 'starting';
        this.room.fallbackStarting = true;
        this.generation += 1;
        return this.generation;
    }

    assertCurrent(generation) {
        if (this._closed || this.generation !== generation || this.state !== 'starting') {
            throw new Error('Fallback relay startup was cancelled.');
        }
    }

    markRunning(generation) {
        this.assertCurrent(generation);
        this.state = 'running';
        this.room.fallbackStarting = false;
    }

    own(name, resource, close = (value) => value?.close?.()) {
        if (this._closed) {
            try { close(resource); } catch {}
            throw new Error('Cannot add a resource to a closed room media pipeline.');
        }
        this.release(name);
        this._resources.set(name, { resource, close });
        return resource;
    }

    setTimer(name, timer, clear = clearTimeout) {
        return this.own(`timer:${name}`, timer, clear);
    }

    release(name) {
        const owned = this._resources.get(name);
        if (!owned) return false;
        this._resources.delete(name);
        try { owned.close(owned.resource); } catch {}
        return true;
    }

    ownWhip(name, resource, close = (value) => value?.close?.()) {
        if (this._closed) {
            try { close(resource); } catch {}
            throw new Error('Cannot add a WHIP resource to a closed room media pipeline.');
        }
        this.releaseWhip(name);
        this._whipResources.set(name, { resource, close });
        return resource;
    }

    releaseWhip(name) {
        const owned = this._whipResources.get(name);
        if (!owned) return false;
        this._whipResources.delete(name);
        try { owned.close(owned.resource); } catch {}
        return true;
    }

    _closeResources(resources) {
        const ownedResources = [...resources.values()].reverse();
        resources.clear();
        for (const owned of ownedResources) {
            try { owned.close(owned.resource); } catch {}
        }
    }

    closeFallback() {
        if (this._closed || this.state === 'idle') return false;
        this.state = 'closing';
        this.generation += 1;
        this.room.fallbackStarting = false;
        this._closeResources(this._resources);
        this.state = 'idle';
        if (this._onFallbackClose) {
            const onClose = this._onFallbackClose;
            this._onFallbackClose = null;
            try { onClose(); } catch {}
        }
        return true;
    }

    close() {
        if (this._closed) return false;
        this.closeFallback();
        this._closed = true;
        this.state = 'closing';
        this.generation += 1;
        this.room.fallbackStarting = false;
        this._closeResources(this._whipResources);
        this.state = 'closed';
        return true;
    }

    get closed() {
        return this._closed;
    }
}

module.exports = { RoomMediaPipeline };
