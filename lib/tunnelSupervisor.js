'use strict';

class TunnelSupervisor {
    constructor({
        config,
        startTunnel,
        normalizeBaseUrl = (value) => value || '',
        getLocalProtocol = () => 'http',
        isServiceReady = () => true,
        onChange = () => {},
        logger = console,
    }) {
        this.config = config;
        this.startTunnel = startTunnel;
        this.normalizeBaseUrl = normalizeBaseUrl;
        this.getLocalProtocol = getLocalProtocol;
        this.isServiceReady = isServiceReady;
        this.onChange = onChange;
        this.logger = logger;
        this.baseUrl = '';
        this.status = config.CLOUDFLARED_TUNNEL_TOKEN
            ? 'starting'
            : (normalizeBaseUrl(config.SHARE_BASE_URL) ? 'manual' : (config.AUTO_PUBLIC_TUNNEL ? 'starting' : 'disabled'));
        this.error = '';
        this._tunnel = null;
        this._restartTimer = null;
        this._restartAttempts = 0;
        this._generation = 0;
        this._closed = false;
    }

    snapshot() {
        return { baseUrl: this.baseUrl, status: this.status, error: this.error };
    }

    _publish(status, error = '', baseUrl = this.baseUrl) {
        this.status = status;
        this.error = error;
        this.baseUrl = baseUrl;
        this.onChange(this.snapshot());
    }

    _scheduleRestart() {
        if (this._closed || this._restartTimer || !this.isServiceReady()) return;
        if (!this.config.AUTO_PUBLIC_TUNNEL && !this.config.CLOUDFLARED_TUNNEL_TOKEN) return;
        const delay = Math.min(60_000, 1_000 * (2 ** Math.min(this._restartAttempts, 6)));
        this._restartAttempts += 1;
        this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            void this.start();
        }, delay);
    }

    async start() {
        if (this._closed) return this.snapshot();
        const generation = ++this._generation;
        const configuredBaseUrl = this.normalizeBaseUrl(this.config.SHARE_BASE_URL);
        const named = !!this.config.CLOUDFLARED_TUNNEL_TOKEN;

        if (configuredBaseUrl && !named) {
            this._publish('manual', '', '');
            return this.snapshot();
        }
        if (!this.config.AUTO_PUBLIC_TUNNEL && !named) {
            this._publish('disabled', '', '');
            return this.snapshot();
        }
        if (this.config.PUBLIC_TUNNEL_PROVIDER !== 'cloudflared') {
            const error = `Unsupported tunnel provider: ${this.config.PUBLIC_TUNNEL_PROVIDER}`;
            this._publish('error', error, '');
            this.logger.warn(`${error}. Skipping tunnel startup.`);
            return this.snapshot();
        }

        this._publish('starting', '', '');
        try {
            const tunnel = await this.startTunnel({
                port: this.config.PORT,
                localProtocol: this.getLocalProtocol(),
                explicitPath: this.config.CLOUDFLARED_PATH,
                timeoutMs: this.config.PUBLIC_TUNNEL_TIMEOUT_MS,
                noTlsVerify: this.config.PUBLIC_TUNNEL_NO_TLS_VERIFY,
                tunnelToken: this.config.CLOUDFLARED_TUNNEL_TOKEN,
                baseUrl: configuredBaseUrl,
            });
            if (this._closed || generation !== this._generation) {
                try { tunnel.stop(); } catch {}
                return this.snapshot();
            }

            this._tunnel = tunnel;
            this._restartAttempts = 0;
            const baseUrl = this.normalizeBaseUrl(tunnel.baseUrl);
            this._publish('active', '', baseUrl);
            this.logger.log(`Public tunnel active: ${baseUrl}`);
            tunnel.process.once('exit', () => {
                if (this._closed || generation !== this._generation) return;
                this._tunnel = null;
                this._publish('error', 'Built-in public tunnel closed.', '');
                this._scheduleRestart();
            });
        } catch (err) {
            if (this._closed || generation !== this._generation) return this.snapshot();
            const message = err?.message || 'Built-in public tunnel failed to start.';
            this._publish('error', message, '');
            this.logger.warn(`Public tunnel unavailable: ${message}`);
            this._scheduleRestart();
        }
        return this.snapshot();
    }

    close() {
        if (this._closed) return false;
        this._closed = true;
        this._generation += 1;
        if (this._restartTimer) clearTimeout(this._restartTimer);
        this._restartTimer = null;
        if (this._tunnel) {
            try { this._tunnel.stop(); } catch {}
        }
        this._tunnel = null;
        this.baseUrl = '';
        return true;
    }
}

module.exports = { TunnelSupervisor };
