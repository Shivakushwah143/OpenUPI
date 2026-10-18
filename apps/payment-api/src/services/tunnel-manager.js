import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Cloudflare Tunnel Process Manager
 * Manages running user-provided cloudflared commands in the background with live log streaming.
 */
export class TunnelManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.status = 'STOPPED'; // 'STOPPED' | 'STARTING' | 'RUNNING' | 'ERROR'
    this.command = null;
    this.logs = [];
    this.maxLogs = 200;
    this.pid = null;
    this.startedAt = null;
  }

  appendLog(line) {
    const entry = {
      timestamp: new Date().toISOString(),
      text: line.trim()
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.emit('log', entry);
  }

  getStatus() {
    return {
      status: this.status,
      command: this.command,
      pid: this.pid,
      startedAt: this.startedAt,
      isRunning: this.status === 'RUNNING' || this.status === 'STARTING',
      recentLogs: this.logs.slice(-50)
    };
  }

  /**
   * Starts the tunnel using a PRE-CONFIGURED binary only (audit P0-01).
   *
   * Arbitrary command text is never executed: the caller cannot supply a command
   * or shell string. The executable path is read from CLOUDFLARE_TUNNEL_BIN and
   * the argument list from CLOUDFLARE_TUNNEL_ARGS (whitespace separated), and the
   * process is spawned WITHOUT a shell, so no shell metacharacters are interpreted.
   * Operators who have not configured a binary must start the tunnel outside the
   * application runtime under a separate low-privilege identity.
   *
   * @param {string} [_ignoredRequestedCommand] retained for signature compatibility; never executed
   */
  start(_ignoredRequestedCommand) {
    const bin = (process.env.CLOUDFLARE_TUNNEL_BIN || '').trim();
    if (!bin) {
      throw new Error(
        'Tunnel execution is disabled. Configure CLOUDFLARE_TUNNEL_BIN (absolute path to cloudflared) and optionally CLOUDFLARE_TUNNEL_ARGS, or run the tunnel outside the application.'
      );
    }

    const args = (process.env.CLOUDFLARE_TUNNEL_ARGS || 'tunnel --no-autoupdate run')
      .split(/\s+/)
      .filter(Boolean);

    if (this.process && (this.status === 'RUNNING' || this.status === 'STARTING')) {
      this.stop();
    }

    this.command = `${bin} ${args.join(' ')}`;
    this.status = 'STARTING';
    this.startedAt = new Date().toISOString();
    this.appendLog('[TunnelManager] Launching operator-configured tunnel binary (no shell).');

    try {
      // No shell: the argument vector is passed directly, so request-derived text
      // can never be interpreted as a command.
      const child = spawn(bin, args, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env }
      });

      this.process = child;
      this.pid = child.pid;
      this.status = 'RUNNING';

      child.stdout.on('data', data => {
        const text = data.toString();
        this.appendLog(`[STDOUT] ${text}`);
      });

      child.stderr.on('data', data => {
        const text = data.toString();
        this.appendLog(`[STDERR] ${text}`);
      });

      child.on('error', err => {
        this.status = 'ERROR';
        this.appendLog(`[ERROR] Process failed to spawn: ${err.message}`);
        this.emit('error', err);
      });

      child.on('close', code => {
        this.appendLog(`[EXIT] Tunnel process exited with code ${code}`);
        this.status = 'STOPPED';
        this.process = null;
        this.pid = null;
        this.emit('exit', code);
      });

      return this.getStatus();
    } catch (err) {
      this.status = 'ERROR';
      this.appendLog(`[ERROR] Exception spawning tunnel: ${err.message}`);
      throw err;
    }
  }

  stop() {
    if (!this.process) {
      this.status = 'STOPPED';
      this.pid = null;
      return this.getStatus();
    }

    this.appendLog(`[TunnelManager] Stopping tunnel process (PID: ${this.pid})...`);
    try {
      if (process.platform === 'win32' && this.pid) {
        spawn('taskkill', ['/pid', String(this.pid), '/f', '/t']);
      } else if (this.pid) {
        process.kill(this.pid, 'SIGTERM');
      }
    } catch (e) {
      this.appendLog(`[TunnelManager] Kill error notice: ${e.message}`);
    }

    this.process = null;
    this.status = 'STOPPED';
    this.pid = null;
    return this.getStatus();
  }
}

// Global singleton instance
export const globalTunnelManager = new TunnelManager();
