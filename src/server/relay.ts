import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server as SocketServer, type Socket } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import type { ServerConfig, CursorState, FolderAgent, CommandPayload, CommandResult } from './types.js';
import type { StateManager } from './state-manager.js';
import type { CommandExecutor } from './command-executor.js';
import type { CDPBridge } from './cdp-bridge.js';
import type { WindowMonitor, WindowSnapshot } from './window-monitor.js';
import { markdownToWebHtml, readPlanFile } from './plan-files.js';
import { ComposerHistory } from './composer-history.js';
import {
  createWebPushManager,
  type WebPushManager,
  type PushSubscriptionRecord,
} from './web-push.js';
import {
  WEBAPP_SESSION_COOKIE,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from './webapp-sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#1a1a2e">
  <title>CursorRemote - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #181818;
      color: rgba(228,228,228,0.92);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100dvh;
    }
    .login-card {
      width: 100%; max-width: 340px; padding: 32px 24px;
      background: #232323; border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; text-align: center; }
    .subtitle { font-size: 13px; color: rgba(228,228,228,0.5); margin-bottom: 24px; text-align: center; }
    label { display: block; font-size: 13px; margin-bottom: 6px; color: rgba(228,228,228,0.7); }
    input[type="password"] {
      width: 100%; padding: 10px 12px; font-size: 15px;
      background: #181818; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
      color: rgba(228,228,228,0.92); outline: none;
    }
    input[type="password"]:focus { border-color: #3794ff; }
    button {
      width: 100%; padding: 10px; margin-top: 16px; font-size: 15px; font-weight: 500;
      background: #3794ff; color: #fff; border: none; border-radius: 8px; cursor: pointer;
    }
    button:hover { background: #2b7ee0; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #e34671; font-size: 13px; margin-top: 12px; text-align: center; display: none; }
  </style>
</head>
<body>
  <form class="login-card" id="form">
    <h1>CursorRemote</h1>
    <p class="subtitle">Enter password to continue</p>
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autocomplete="current-password" autofocus required>
    <button type="submit" id="btn">Sign in</button>
    <p class="error" id="err"></p>
  </form>
  <script>
    const form = document.getElementById('form');
    const pw = document.getElementById('pw');
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.style.display = 'none';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('cursor-remote-token', data.token);
          window.location.href = '/';
        } else {
          err.textContent = data.error || 'Invalid password';
          err.style.display = 'block';
        }
      } catch {
        err.textContent = 'Network error';
        err.style.display = 'block';
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`;

export class Relay {
  private config: ServerConfig;
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>;
  private io: SocketServer;
  private stateManager: StateManager;
  private commandExecutor: CommandExecutor;
  private cdpBridge: CDPBridge;
  /** Per-window snapshots (set by WindowMonitor via `setWindowMonitor`).
   *  Used to feed the web client the state of the window it is *viewing* —
   *  in particular questions/approvals raised in a window that is not the
   *  relay's CDP "home" window. Without this the phone only ever saw the home
   *  window's questionnaire and appeared to miss questions entirely. */
  private windowMonitor: WindowMonitor | null = null;

  private sessionStore: WebappSessionStore;
  private loginAttempts = new Map<string, RateLimitEntry>();
  private webPush: WebPushManager;
  /**
   * Reads the FULL transcript for a composer from Cursor's SQLite store. Cursor
   * virtualizes the transcript DOM, so the DOM extractor only ever yields a few
   * mounted messages; this restores complete history when switching folders.
   */
  private composerHistory: ComposerHistory;
  /** Composer whose full history was most recently loaded (guards stale reads). */
  private historyComposerId = '';
  /** Latest push-relevant signals per window (from window:update snapshots). */
  private pushWindowSignals = new Map<string, {
    questionnaire: boolean;
    approval: boolean;
    working: boolean;
    questionText: string;
    approvalDesc: string;
    title: string;
  }>();
  /** Edge bookkeeping for push transitions (mirrors the client's logic). */
  private pushHadQuestionnaire = false;
  private pushHadApproval = false;
  private pushWasWorking = false;
  private pushFinishTimer: ReturnType<typeof setTimeout> | null = null;
  private pushPrimed = false;
  /** Composer the push edge-state belongs to — switch re-primes (see evaluatePushTransition). */
  private pushComposerId = '';
  private static readonly PUSH_FINISH_SETTLE_MS = 5000;
  /**
   * How long a push may sit in the delivery queue. The web-push library
   * defaults to four weeks, which is why locking the phone and unlocking
   * later could surface a "finished" alert from hours/days ago. Finished
   * alerts are only useful when fresh; "needs you" stays a bit longer.
   */
  private static readonly PUSH_TTL_FINISHED_SEC = 60;
  private static readonly PUSH_TTL_NEEDS_YOU_SEC = 3600;
  /**
   * Haptic patterns per push type. A web push cannot choose its alert sound
   * (the OS owns that), so a distinct vibration is the most a background alert
   * can do to signal "needs you" vs "finished". "Needs you" is a longer,
   * insistent triple buzz; "finished" is a single short tap.
   */
  private static readonly PUSH_VIBRATE_NEEDS_YOU = [200, 100, 200, 100, 200];
  private static readonly PUSH_VIBRATE_FINISHED = [120];

  /**
   * Forces an immediate re-read of Cursor (wired by index.ts to the DOM
   * extractor + window monitor). Lets the phone recover when the agent on
   * screen is out of sync with Cursor — e.g. the remote still shows "working"
   * while the real app has already finished.
   */
  private refreshHandler: (() => void) | null = null;

  /**
   * Nudge the DOM extractor out of the idle poll cadence (wired by index.ts).
   * Fired on every inbound client command so a reply that lands while the phone
   * was idle shows up immediately instead of waiting out the slow idle interval.
   */
  private wakeHandler: (() => void) | null = null;

  /** Max-Age for session cookie (30 days), aligned with typical “stay signed in” expectation. */
  private static readonly SESSION_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

  private get authEnabled(): boolean {
    return this.config.webappPassword.length > 0;
  }

  constructor(
    config: ServerConfig,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.sessionStore = createWebappSessionStore(config.dataDir);
    this.webPush = createWebPushManager(
      config.dataDir,
      config.webPush.subject,
      config.webPush.enabled
    );
    this.composerHistory = new ComposerHistory({
      dbPath: config.cursorStateDb,
      maxMessages: config.historyMaxMessages,
    });
    if (config.cursorStateDb) {
      console.log(`[relay] Full-history source: ${config.cursorStateDb}`);
    } else {
      console.warn('[relay] Cursor state DB not found — chat history will be limited to the virtualized DOM');
    }

    this.app = express();
    if (this.config.trustProxy) {
      // Trust the fronting proxy's X-Forwarded-* headers so client IPs (used
      // for login rate limiting) and req.protocol are correct behind TLS.
      this.app.set('trust proxy', true);
    }
    this.httpServer = this.createWebServer();
    this.io = new SocketServer(this.httpServer, {
      serveClient: false,
      cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true,
      },
      // Latency tuning for the phone-over-Cloudflare-tunnel path:
      // - pingTimeout 60s (default 20s): backgrounded mobile clients + tunnel
      //   RTT caused constant "ping timeout" churn in the logs, and every
      //   reconnect restarts from scratch. A wider window rides out stalls.
      // - maxHttpBufferSize 8MB (default 1MB): history:full payloads can exceed
      //   1MB and were chunked across multiple polling round trips through the
      //   tunnel (each ~100-300ms RTT).
      // - perMessageDeflate: state:patch carries the full messages array (incl.
      //   HTML) on every streaming tick; HTML compresses ~10x, which dominates
      //   perceived latency on constrained mobile links. Threshold keeps tiny
      //   packets (pings/acks) uncompressed.
      pingInterval: 25000,
      pingTimeout: 60000,
      maxHttpBufferSize: 8e6,
      perMessageDeflate: { threshold: 1024 },
    });

    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupStateForwarding();

    if (this.authEnabled) {
      console.log('[relay] Web app password protection enabled');
    }
  }

  /**
   * Create the HTTP or HTTPS server for the web client, depending on config.
   * Native TLS (https/wss) is used when TLS_ENABLED is set with cert+key files;
   * otherwise plain HTTP is used (optionally behind a TLS-terminating proxy).
   */
  private createWebServer(): ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer> {
    if (!this.config.tls.enabled) {
      return createServer(this.app);
    }
    const { certPath, keyPath, caPath, passphrase } = this.config.tls;
    try {
      const cert = readFileSync(certPath);
      const key = readFileSync(keyPath);
      const ca = caPath ? readFileSync(caPath) : undefined;
      console.log(`[relay] TLS enabled — cert: ${certPath}`);
      return createHttpsServer(
        {
          cert,
          key,
          ...(ca ? { ca } : {}),
          ...(passphrase ? { passphrase } : {}),
        },
        this.app
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `TLS is enabled but the certificate/key could not be read (${msg}). ` +
          `Check TLS_CERT_PATH and TLS_KEY_PATH, or unset TLS_ENABLED to serve plain HTTP.`
      );
    }
  }

  private get scheme(): 'http' | 'https' {
    return this.config.tls.enabled ? 'https' : 'http';
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.serverPort, this.config.serverHost, () => {
        console.log(
          `[relay] Server listening on ${this.scheme}://${this.config.serverHost}:${this.config.serverPort}`
        );
        resolve();
      });
    });
  }

  /** Wire a callback that forces an immediate fresh extraction from Cursor.
   *  Invoked by the web client's "Refresh" affordance and by the stall
   *  self-heal in index.ts. */
  setRefreshHandler(handler: () => void): void {
    this.refreshHandler = handler;
  }

  /** Wire a callback that wakes the extractor from its idle poll cadence.
   *  Invoked before running any inbound client command. */
  setWakeHandler(handler: () => void): void {
    this.wakeHandler = handler;
  }

  /** Wire the window monitor so the web client can be fed the state of the
   *  window it is viewing, not just the relay's CDP home window. */
  setWindowMonitor(windowMonitor: WindowMonitor): void {
    this.windowMonitor = windowMonitor;
    windowMonitor.on('window:update', this.onWindowUpdate);
  }

  /**
   * Ask the extractor to re-read Cursor immediately and echo the resulting
   * state back. Used by `command:refresh_state`; returns the newest snapshot
   * so the client can render it without waiting for the debounced push.
   */
  private requestRefresh(): CursorState {
    // Re-arm the stall baseline so the nudge clears at once and only returns
    // if the DOM freezes again. Done before extraction so the fresh reading is
    // measured against this moment.
    this.stateManager.resetStall();
    this.refreshHandler?.();
    return this.stateManager.getCurrentState();
  }

  private onWindowUpdate = (windowId: string, snapshot: WindowSnapshot): void => {
    // Record push-relevant signals for every window (home or not) so the
    // transition evaluator sees questions/approvals raised anywhere.
    const hasQ = !!(snapshot.questionnaire && snapshot.questionnaire.questions?.length);
    const hasA = (snapshot.pendingApprovals?.length ?? 0) > 0;
    const sig = {
      questionnaire: hasQ,
      approval: hasA,
      working: snapshot.canAbort || snapshot.agentActivityLive
        || (snapshot.agentStatus !== 'idle'
          && snapshot.agentStatus !== 'waiting_approval'
          && snapshot.agentStatus !== 'error'),
      questionText: hasQ
        ? ((snapshot.questionnaire!.questions[snapshot.questionnaire!.activeIndex]
            ?? snapshot.questionnaire!.questions[0])?.text || '').slice(0, 160)
        : '',
      approvalDesc: hasA ? (snapshot.pendingApprovals[0]?.description || '') : '',
      title: snapshot.windowTitle,
    };
    this.pushWindowSignals.set(windowId, sig);

    // Forward non-home window state to web clients so a question/approval
    // raised in a window other than the relay's CDP home window is still
    // surfaced on the phone (previously only Telegram saw these). The payload
    // is intentionally lean — the client uses it to surface + route the
    // interaction, not to render another window's transcript.
    this.io.emit('window:snapshot', {
      windowId,
      windowTitle: snapshot.windowTitle,
      questionnaire: snapshot.questionnaire,
      pendingApprovals: snapshot.pendingApprovals,
      agentStatus: snapshot.agentStatus,
      agentActivityText: snapshot.agentActivityText,
      agentActivityLive: snapshot.agentActivityLive,
      agentActivitySource: snapshot.agentActivitySource,
      // Ground-truth working flag, so the client can mark this window's agent
      // as "working" in the folder menu even when it is not the home window.
      canAbort: snapshot.canAbort,
      activeComposerId: snapshot.activeComposerId,
      folders: snapshot.folders,
      lastUpdated: snapshot.lastUpdated,
    });

    this.evaluatePushTransition();
  };

  /**
   * Ensure the relay's CDP "home" connection points at `windowId` before an
   * interaction (questionnaire answer, approval, click) is executed against it.
   * The command executor and DOM extractor only ever act on the home window, so
   * a question raised in another window must switch home first — otherwise the
   * answer's selector path (scoped to that window's DOM) would miss. No-op when
   * the window is already active or `windowId` is unknown.
   */
  private async ensureHomeWindow(windowId?: string): Promise<void> {
    if (!windowId || !this.windowMonitor) return;
    if (windowId === this.cdpBridge.activeTargetId) return;
    try {
      await this.cdpBridge.switchWindow(windowId);
      this.windowMonitor.setHomeWindow(windowId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[relay] Failed to switch to window ${windowId.substring(0, 8)} for command: ${msg}`);
    }
  }

  async stop(): Promise<void> {
    this.io.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  private getClientIp(req: express.Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
  }

  private checkRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const entry = this.loginAttempts.get(ip);

    if (!entry || now >= entry.resetAt) {
      this.loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, retryAfter: 0 };
    }

    if (entry.count >= 10) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.count++;
    return { allowed: true, retryAfter: 0 };
  }

  /** First matching credential that exists in the persisted session store. */
  private resolveHttpSession(req: express.Request): string | undefined {
    if (!this.authEnabled) return undefined;
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (this.sessionStore.has(t)) return t;
    }
    const fromCookie = parseSessionCookie(req.headers.cookie, WEBAPP_SESSION_COOKIE);
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private resolveSocketSession(socket: Socket): string | undefined {
    if (!this.authEnabled) return undefined;
    const raw = socket.handshake.auth?.token;
    const bearer = typeof raw === 'string' ? raw.trim() : '';
    if (bearer && this.sessionStore.has(bearer)) return bearer;
    const cookieHeader = socket.handshake.headers.cookie;
    const fromCookie = parseSessionCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      WEBAPP_SESSION_COOKIE
    );
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private setupRoutes(): void {
    const clientDir = join(__dirname, '..', 'client');

    this.app.use(express.json());

    this.app.get('/login', (_req, res) => {
      if (!this.authEnabled) return res.redirect('/');
      res.type('html').send(LOGIN_PAGE_HTML);
    });

    this.app.post('/api/login', (req, res) => {
      if (!this.authEnabled) return res.json({ token: 'no-auth' });

      const ip = this.getClientIp(req);
      const { allowed, retryAfter } = this.checkRateLimit(ip);
      if (!allowed) {
        console.warn(`[relay] Rate limited login from ${ip}`);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfter}s.` });
      }

      const password = req.body?.password;
      if (typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: 'Password required' });
      }

      const expected = Buffer.from(this.config.webappPassword);
      const received = Buffer.from(password);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        console.warn(`[relay] Failed login attempt from ${ip}`);
        return res.status(401).json({ error: 'Invalid password' });
      }

      const token = randomBytes(32).toString('hex');
      this.sessionStore.add(token);
      console.log(`[relay] Successful login from ${ip}`);
      // Mark the session cookie Secure whenever the connection is (or is
      // proxied as) HTTPS so it is never sent over plaintext. `req.secure`
      // honors X-Forwarded-Proto when trustProxy is set.
      const isSecure = req.secure || req.protocol === 'https';
      res.setHeader(
        'Set-Cookie',
        [
          `${WEBAPP_SESSION_COOKIE}=${token}`,
          'HttpOnly',
          'Path=/',
          'SameSite=Lax',
          ...(isSecure ? ['Secure'] : []),
          `Max-Age=${Relay.SESSION_COOKIE_MAX_AGE_SEC}`,
        ].join('; ')
      );
      return res.json({ token });
    });

    this.app.get('/health', (req, res) => {
      const state = this.stateManager.getCurrentState();
      const sessionOk = !this.authEnabled || this.resolveHttpSession(req) !== undefined;
      res.json({
        ok: true,
        authRequired: this.authEnabled,
        sessionValid: sessionOk,
        connected: state.connected,
        extractorStatus: state.extractorStatus,
        lastExtractionAt: state.lastExtractionAt,
        consecutiveExtractionFailures: state.consecutiveExtractionFailures,
        lastExtractionError: state.lastExtractionError,
        agentStatus: state.agentStatus,
        canAbort: state.canAbort,
        agentStalled: state.agentStalled,
        agentActivityText: state.agentActivityText,
        agentActivityLive: state.agentActivityLive,
        clients: this.io.engine.clientsCount,
        uptime: process.uptime(),
        windows: state.windows,
        activeWindowId: state.activeWindowId,
        mode: state.mode?.current ?? null,
        model: state.model?.current ?? null,
        chatTabCount: state.chatTabs?.length ?? 0,
        folderCount: state.folders?.length ?? 0,
        pendingApprovalCount: state.pendingApprovals?.length ?? 0,
        generation: this.stateManager.generation,
      });
    });

    this.app.get('/debug/state', (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const state = this.stateManager.getCurrentState();
      res.json({
        activeWindowId: state.activeWindowId,
        agentStatus: state.agentStatus,
        canAbort: state.canAbort,
        agentStalled: state.agentStalled,
        agentStalledSince: state.agentStalledSince,
        agentActivityText: state.agentActivityText,
        agentActivityLive: state.agentActivityLive,
        pendingApprovals: state.pendingApprovals,
        chatTabs: state.chatTabs.map((t) => ({
          isActive: t.isActive,
          title: t.title,
          composerId: t.composerId.substring(0, 16),
        })),
        windows: state.windows.map((w) => ({ id: w.id.substring(0, 8), title: w.title })),
        folderCount: state.folders?.length ?? 0,
        folders: (state.folders ?? []).map((f) => ({
          name: f.name,
          kind: f.kind,
          isCurrent: f.isCurrent,
          agents: f.agents.map((a) => a.title),
        })),
        composerQueue: state.composerQueue,
        messageCount: state.messages.length,
        lastMessages: state.messages.slice(-3).map((m) => ({
          type: m.type,
          flatIndex: m.flatIndex,
          ...(m.type === 'tool' || m.type === 'run_command' ? {
            actions: 'actions' in m ? m.actions?.length ?? 0 : 0,
          } : {}),
        })),
        generation: this.stateManager.generation,
      });
    });

    const cacheBust = Date.now().toString(36);
    this.app.get('/', (_req, res) => {
      const htmlPath = join(clientDir, 'index.html');
      try {
        let html = readFileSync(htmlPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)\.(js|css)"/g, `$1="$2.$3?v=${cacheBust}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html);
      } catch (err) {
        console.error(`[relay] Failed to serve index.html: ${err}`);
        res.status(500).send('Client files not found');
      }
    });

    this.app.use(express.static(clientDir, {
      etag: true,
      lastModified: true,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      },
    }));

    // --- Web Push (real notifications: service worker + VAPID) ---
    // Public key is needed by the client to subscribe; it's not a secret.
    this.app.get('/api/push/public-key', (_req, res) => {
      res.json({ enabled: this.webPush.enabled, publicKey: this.webPush.getPublicKey() });
    });

    this.app.post('/api/push/subscribe', (req, res) => {
      if (!this.webPush.enabled) {
        return res.status(503).json({ error: 'Push not enabled' });
      }
      const body = req.body as Partial<PushSubscriptionRecord> | undefined;
      const endpoint = body?.endpoint;
      const p256dh = body?.keys?.p256dh;
      const auth = body?.keys?.auth;
      if (typeof endpoint !== 'string' || !endpoint
        || typeof p256dh !== 'string' || !auth
        || typeof auth !== 'string') {
        console.warn(
          `[web-push] Rejected subscription: endpoint=${typeof endpoint} `
          + `p256dh=${typeof p256dh} auth=${typeof auth} `
          + `bodyKeys=${body ? Object.keys(body).join(',') : 'none'}`
        );
        return res.status(400).json({ error: 'Invalid subscription' });
      }
      const label = typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent'].slice(0, 200)
        : undefined;
      this.webPush.addSubscription({
        endpoint,
        keys: { p256dh, auth },
        label,
        createdAt: Date.now(),
      });
      res.json({ ok: true, count: this.webPush.getSubscriptionCount() });
    });

    this.app.post('/api/push/unsubscribe', (req, res) => {
      const endpoint = (req.body as { endpoint?: unknown } | undefined)?.endpoint;
      if (typeof endpoint !== 'string' || !endpoint) {
        return res.status(400).json({ error: 'Missing endpoint' });
      }
      this.webPush.removeSubscription(endpoint);
      res.json({ ok: true, count: this.webPush.getSubscriptionCount() });
    });

    const authMiddleware: express.RequestHandler = (req, res, next) => {
      if (!this.authEnabled) return next();

      if (this.resolveHttpSession(req)) return next();

      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/login');
    };

    this.app.use(authMiddleware);
  }

  private setupSocketHandlers(): void {
    if (this.authEnabled) {
      this.io.use((socket, next) => {
        const resolved = this.resolveSocketSession(socket);
        if (resolved) return next();
        const raw = socket.handshake.auth?.token;
        const hint =
          typeof raw === 'string' && raw.length > 0
            ? raw.slice(0, 8) + '...'
            : parseSessionCookie(
                typeof socket.handshake.headers.cookie === 'string'
                  ? socket.handshake.headers.cookie
                  : undefined,
                WEBAPP_SESSION_COOKIE
              )
              ? 'cookie-present'
              : 'empty';
        console.warn(`[relay] Socket.io auth rejected (${socket.id}) — ${hint}`);
        next(new Error('Unauthorized'));
      });
    }

    this.io.on('connection', (socket) => {
      console.log(`[relay] Client connected: ${socket.id}`);

      socket.emit('state:full', this.stateManager.getCurrentState());

      // Any inbound command implies the DOM is about to change. If the extractor
      // has parked at the slow idle cadence, wake it so the reply and its
      // streaming tail appear immediately instead of up to one idle interval
      // later. Restricted to command/request events so routine traffic (e.g.
      // reconnects) never triggers extra polls.
      socket.onAny((event: string) => {
        if (event.startsWith('command:') || event.startsWith('request:')) {
          this.wakeHandler?.();
        }
      });

      socket.on('command:send_message', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.text) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or text',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: send_message from ${socket.id}`);
        const result = await this.commandExecutor.sendMessage(
          payload.commandId,
          payload.text
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve from ${socket.id}`);
        const result = await this.commandExecutor.clickApproval(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve_all', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve_all from ${socket.id}`);
        const result = await this.commandExecutor.approveAll(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:reject', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: reject from ${socket.id}`);
        const result = await this.commandExecutor.reject(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_tab', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.tabTitle && !payload.selectorPath)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and tab target',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_tab to "${payload.tabTitle ?? payload.selectorPath}" from ${socket.id}`);
        const result = await this.commandExecutor.switchTab(
          payload.commandId,
          payload.tabTitle ?? '',
          payload.selectorPath
        );
        socket.emit('command:result', result);
        if (payload.composerId) {
          this.historyComposerId = payload.composerId;
          await this.loadComposerHistory(payload.composerId, socket);
        }
      });

      socket.on('command:open_folder_agent', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.composerId && !payload.tabTitle && !payload.selectorPath)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and agent target',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: open_folder_agent "${payload.tabTitle ?? payload.composerId}" from ${socket.id}`);
        const result = await this.commandExecutor.openFolderAgent(
          payload.commandId,
          payload.composerId,
          payload.tabTitle,
          payload.selectorPath
        );
        socket.emit('command:result', result);
        // Restore the FULL transcript from Cursor's database. The DOM only
        // mounts a few messages, so switching folders otherwise showed a
        // clipped history until the user scrolled.
        if (payload.composerId) {
          this.historyComposerId = payload.composerId;
          this.composerHistory.invalidate(payload.composerId);
          await this.loadComposerHistory(payload.composerId, socket);
        }
      });

      socket.on('request:history', async (payload?: { composerId?: string }) => {
        const composerId = (payload?.composerId || this.stateManager.getCurrentState().activeComposerId || '').trim();
        if (!composerId) return;
        this.historyComposerId = composerId;
        await this.loadComposerHistory(composerId, socket);
      });

      socket.on('command:create_folder_agent', async (payload: CommandPayload) => {
        const sectionId = (payload.sectionId || '').trim();
        const folderName = (payload.folderName || '').trim();
        if (!payload.commandId || (!sectionId && !folderName)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and folder target',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: create_folder_agent in "${folderName || sectionId}" from ${socket.id}`);
        const result = await this.commandExecutor.createFolderAgent(
          payload.commandId,
          sectionId,
          folderName || sectionId.replace(/^folder:/, '')
        );
        socket.emit('command:result', result);
        // Cursor opened the composer on the host; the next extraction picks up
        // the new agent's composerId and pushes a fresh snapshot. Nudge the
        // client so the UI switches over without waiting for the poll cycle.
        if (result.ok) {
          // Poll for the composer to actually CHANGE rather than grabbing
          // whatever is active after a fixed delay: the 1.2s timer used to fire
          // while `activeComposerId` still pointed at the PREVIOUS folder's
          // agent, so the relay loaded (and pushed) the wrong transcript. We
          // capture the pre-create id and only load once it differs.
          const before = this.stateManager.getCurrentState().activeComposerId || '';
          let waited = 0;
          const step = 400;
          const attempt = (): void => {
            waited += step;
            const composerId = this.stateManager.getCurrentState().activeComposerId || '';
            const changed = !!composerId && composerId !== before;
            if (!changed && waited < 6000) {
              setTimeout(attempt, step);
              return;
            }
            // Only load once the composer is known to have changed; if it never
            // did, skip (the client pins the new agent and requests its history).
            if (changed) {
              this.historyComposerId = composerId;
              this.composerHistory.invalidate(composerId);
              void this.loadComposerHistory(composerId, socket);
            }
          };
          setTimeout(attempt, step);
        }
      });

      socket.on('command:archive_folder_agent', async (payload: CommandPayload) => {
        const composerId = (payload.composerId || '').trim();
        const tabTitle = (payload.tabTitle || '').trim();
        if (!payload.commandId || (!composerId && !tabTitle)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and agent target',
          } satisfies CommandResult);
          return;
        }
        const action = payload.archiveAction === 'unarchive' ? 'unarchive' : 'archive';
        console.log(`[relay] Command: archive_folder_agent ${action} "${tabTitle || composerId}" from ${socket.id}`);
        const result = await this.commandExecutor.archiveFolderAgent(
          payload.commandId,
          composerId,
          tabTitle,
          action
        );
        socket.emit('command:result', result);
        if (result.ok) {
          // Best-effort: the archive already happened, so a refresh/history
          // hiccup must not surface as a command failure.
          try {
            // The sidebar row list is the only thing that changed; push a fresh
            // snapshot so the drawer drops/restores the row immediately instead
            // of waiting for the next poll.
            socket.emit('state:full', this.requestRefresh());
            // If the archived agent was the open chat, its history is no longer
            // relevant. Only reload when the active composer actually moved on.
            const nowActive = this.stateManager.getCurrentState().activeComposerId || '';
            if (action === 'archive' && composerId && nowActive && nowActive !== composerId) {
              this.historyComposerId = nowActive;
              void this.loadComposerHistory(nowActive, socket);
            }
          } catch (err) {
            console.warn(`[relay] Post-archive refresh failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });

      socket.on('command:new_chat', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: new_chat from ${socket.id}`);
        const result = await this.commandExecutor.newChat(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:set_mode', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modeId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modeId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_mode to ${payload.modeId} from ${socket.id}`);
        const result = await this.commandExecutor.setMode(
          payload.commandId,
          payload.modeId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_model to ${payload.modelId} from ${socket.id}`);
        const result = await this.commandExecutor.setModel(
          payload.commandId,
          payload.modelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getModelOptions(
          payload.commandId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_plan_full', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.planLabel) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or planLabel',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_full for ${payload.planLabel} from ${socket.id}`);
        const planFile = readPlanFile(payload.planLabel);
        if (!planFile) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Plan file not found',
          } satisfies CommandResult);
          return;
        }
        socket.emit('command:result', {
          commandId: payload.commandId,
          ok: true,
          data: {
            todos: planFile.todos,
            body: planFile.body,
            bodyHtml: markdownToWebHtml(planFile.body),
          },
        } satisfies CommandResult);
      });

      socket.on('command:get_plan_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getPlanModelOptions(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_plan_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath || !payload.planModelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, selectorPath, or planModelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_plan_model to ${payload.planModelId} from ${socket.id}`);
        const result = await this.commandExecutor.setPlanModel(
          payload.commandId,
          payload.selectorPath,
          payload.planModelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:click_action', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: click_action from ${socket.id}`);
        await this.ensureHomeWindow(payload.windowId);
        const result = await this.commandExecutor.clickAction(
          payload.commandId,
          payload.selectorPath,
          payload.actionLabel
        );
        socket.emit('command:result', result);
      });

      // --- Queued-message actions (newer hover-mounted tray rows) ---
      socket.on('command:queue_action', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.queueItemId || !payload.queueAction) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, queueItemId, or queueAction',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: queue_action (${payload.queueAction}) from ${socket.id}`);
        await this.ensureHomeWindow(payload.windowId);
        const result = await this.commandExecutor.queueRowAction(
          payload.commandId,
          payload.queueItemId,
          payload.queueAction
        );
        socket.emit('command:result', result);
      });

      // --- Text entry without sending (freeform questionnaire answers) ---
      socket.on('command:set_answer_text', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath || typeof payload.text !== 'string') {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, selectorPath, or text',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_answer_text from ${socket.id}`);
        await this.ensureHomeWindow(payload.windowId);
        const result = await this.commandExecutor.setAnswerText(
          payload.commandId,
          payload.selectorPath,
          payload.text
        );
        socket.emit('command:result', result);
      });

      // --- Send the current composer contents as a prompt (after slash/text edits) ---
      socket.on('command:send_prompt', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', { commandId: 'unknown', ok: false, error: 'Missing commandId' } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: send_prompt from ${socket.id}`);
        const result = await this.commandExecutor.submitComposer(payload.commandId, payload.text);
        socket.emit('command:result', result);
      });

      // --- Slash command tray (`/`) ---
      socket.on('command:get_slash_menu', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', { commandId: 'unknown', ok: false, error: 'Missing commandId' } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_slash_menu${payload.slashQuery ? ` (q="${payload.slashQuery}")` : ''} from ${socket.id}`);
        const result = await this.commandExecutor.getSlashMenu(payload.commandId, payload.slashQuery ?? '');
        socket.emit('command:result', result);
      });

      socket.on('command:click_slash_command', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.slashId && payload.slashIndex == null)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and slash target',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: click_slash_command (${payload.slashId ?? payload.slashIndex}) from ${socket.id}`);
        const result = await this.commandExecutor.clickSlashCommand(
          payload.commandId,
          payload.slashId,
          payload.slashIndex,
          payload.slashQuery ?? ''
        );
        socket.emit('command:result', result);
      });

      socket.on('command:cancel_slash_menu', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', { commandId: 'unknown', ok: false, error: 'Missing commandId' } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: cancel_slash_menu from ${socket.id}`);
        const result = await this.commandExecutor.cancelSlashMenu(payload.commandId);
        socket.emit('command:result', result);
      });

      // --- Abort the current generation/turn ---
      socket.on('command:stop_generation', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', { commandId: 'unknown', ok: false, error: 'Missing commandId' } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: stop_generation from ${socket.id}`);
        const result = await this.commandExecutor.stopGeneration(payload.commandId);
        socket.emit('command:result', result);
      });

      // --- Force an immediate re-read of Cursor ("Refresh" / stall recovery) ---
      // The phone uses this when it suspects its view is out of sync — e.g. the
      // remote still shows the agent as working while Cursor has finished.
      socket.on('command:refresh_state', (payload: CommandPayload) => {
        const commandId = payload?.commandId ?? 'unknown';
        console.log(`[relay] Command: refresh_state from ${socket.id}`);
        const fresh = this.requestRefresh();
        socket.emit('command:result', { commandId, ok: true } satisfies CommandResult);
        socket.emit('state:full', fresh);
      });

      socket.on('command:switch_window', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.windowId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or windowId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_window to ${payload.windowId} from ${socket.id}`);
        try {
          await this.cdpBridge.switchWindow(payload.windowId);
          socket.emit('command:result', { commandId: payload.commandId, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

      socket.on('disconnect', (reason) => {
        console.log(`[relay] Client disconnected: ${socket.id} (${reason})`);
      });
    });
  }

  private setupStateForwarding(): void {
    this.stateManager.on('state:patch', (patch: Partial<CursorState>) => {
      this.io.emit('state:patch', patch);
      this.evaluatePushTransition();
    });

    this.stateManager.on('connection:changed', (connected: boolean) => {
      this.io.emit('connection:status', { connected });
    });
  }

  /**
   * Load the complete transcript for `composerId` straight from Cursor's
   * database and push it to clients. Cursor virtualizes the transcript DOM (only
   * a handful of messages are ever mounted), so without this the remote's
   * transcript is clipped to whatever is currently rendered — the "switching
   * folders doesn't load the full history" bug. The client merges this with the
   * live DOM tail (deduped by message id) so streaming keeps updating it.
   */
  private async loadComposerHistory(composerId: string, target?: Socket): Promise<void> {
    if (!composerId) return;
    const history = await this.composerHistory.getHistory(composerId);
    if (!history || history.messages.length === 0) return;
    if (this.historyComposerId !== composerId) return; // Composer switched mid-read.

    const payload = {
      composerId,
      name: history.name,
      total: history.total,
      truncated: history.truncated,
      messages: history.messages,
    };
    // Unicast to the requesting client when known. These payloads can be
    // several MB (2000 mapped messages incl. HTML); broadcasting to every
    // socket makes each connected client hold its own copy and lets a
    // slow/stalled client buffer unboundedly.
    if (target && target.connected) {
      target.emit('history:full', payload);
    } else {
      this.io.emit('history:full', payload);
    }
    console.log(
      `[relay] History loaded for ${composerId.substring(0, 8)} "${history.name}": ${history.messages.length}/${history.total} messages`
    );
  }

  private isWorkingState(s: CursorState): boolean {
    if (!s.connected) return false;
    if (s.canAbort || s.agentActivityLive) return true;
    return s.agentStatus !== 'idle'
      && s.agentStatus !== 'waiting_approval'
      && s.agentStatus !== 'error';
  }

  private questionText(q: CursorState['questionnaire']): string {
    if (!q || !q.questions || q.questions.length === 0) return '';
    const active = q.questions[q.activeIndex] ?? q.questions[0];
    return (active?.text || '').slice(0, 160);
  }

  /** Merge the home window's live state with other windows' latest signals. */
  private aggregatePushSignals(): {
    hasQ: boolean; hasA: boolean; working: boolean;
    questionText: string; approvalDesc: string;
  } {
    const state = this.stateManager.getCurrentState();
    const homeId = this.windowMonitor?.getHomeWindowId() ?? state.activeWindowId;
    const homeQ = !!(state.questionnaire && state.questionnaire.questions?.length);
    const homeA = (state.pendingApprovals?.length ?? 0) > 0;
    let hasQ = homeQ;
    let hasA = homeA;
    let working = this.isWorkingState(state);
    let questionText = homeQ ? this.questionText(state.questionnaire) : '';
    let approvalDesc = homeA ? (state.pendingApprovals[0]?.description || '') : '';
    for (const [wid, sig] of this.pushWindowSignals) {
      if (wid === homeId) continue;
      hasQ = hasQ || sig.questionnaire;
      hasA = hasA || sig.approval;
      working = working || sig.working;
      if (!questionText && sig.questionnaire) questionText = sig.questionText;
      if (!approvalDesc && sig.approval) approvalDesc = sig.approvalDesc;
    }
    return { hasQ, hasA, working, questionText, approvalDesc };
  }

  /**
   * Edge-triggered web push. Mirrors the client's notification logic: push only
   * when the agent NEWLY asks a question / needs approval, or when it has
   * genuinely finished (working -> idle, debounced so mid-run gaps don't fire).
   *
   * Guards against two false positives the phone was seeing:
   *   - CDP/home disconnect looks idle (`isWorkingState` is false) — must not
   *     schedule a finish alert; cancel any in-flight settle timer instead.
   *   - Switching the home composer (folder navigation) re-primes so the
   *     previous agent's "was working" bit is not attributed to the new one.
   */
  private evaluatePushTransition(): void {
    if (!this.webPush.enabled) return;
    const state = this.stateManager.getCurrentState();
    const composerId = state.activeComposerId || '';
    const { hasQ, hasA, working, questionText, approvalDesc } = this.aggregatePushSignals();

    if (!this.pushPrimed) {
      this.pushPrimed = true;
      this.pushComposerId = composerId;
      this.pushHadQuestionnaire = hasQ;
      this.pushHadApproval = hasA;
      this.pushWasWorking = working;
      return;
    }

    if (composerId !== this.pushComposerId) {
      if (this.pushFinishTimer) {
        clearTimeout(this.pushFinishTimer);
        this.pushFinishTimer = null;
      }
      this.pushComposerId = composerId;
      this.pushHadQuestionnaire = hasQ;
      this.pushHadApproval = hasA;
      this.pushWasWorking = working;
      return;
    }

    // Home CDP drop: don't treat "not connected" as a finish. Keep the
    // was-working bit so a real finish that landed while CDP was down is still
    // announced once we reconnect to a settled idle state for this composer.
    if (!state.connected) {
      if (this.pushFinishTimer) {
        clearTimeout(this.pushFinishTimer);
        this.pushFinishTimer = null;
      }
      return;
    }

    if (hasQ && !this.pushHadQuestionnaire) {
      void this.push(
        'Agent has a question',
        questionText || 'The agent is asking you something.',
        'cursor-questionnaire',
        Relay.PUSH_VIBRATE_NEEDS_YOU,
        Relay.PUSH_TTL_NEEDS_YOU_SEC
      );
    } else if (hasA && !this.pushHadApproval) {
      void this.push(
        'Agent needs approval',
        approvalDesc || 'The agent is waiting for your approval.',
        'cursor-approval',
        Relay.PUSH_VIBRATE_NEEDS_YOU,
        Relay.PUSH_TTL_NEEDS_YOU_SEC
      );
    }

    if (working) {
      this.pushWasWorking = true;
      if (this.pushFinishTimer) {
        clearTimeout(this.pushFinishTimer);
        this.pushFinishTimer = null;
      }
    } else if (this.pushWasWorking) {
      this.scheduleFinishCheck();
    }

    this.pushHadQuestionnaire = hasQ;
    this.pushHadApproval = hasA;
  }

  /**
   * Name the agent/chat that most likely just finished, for the background push
   * body. Prefers the home window's active chat tab, then the active agent of
   * the finished agent's workspace folder, then the window title (ignoring the
   * generic "Cursor Agents" overview), and appends the workspace it ran in.
   * Returns '' when nothing is known, so the caller keeps its generic wording.
   */
  private finishedPushLabel(): string {
    const state = this.stateManager.getCurrentState();
    const tabs = state.chatTabs ?? [];
    const activeTab = tabs.find((t) => t.isActive)
      || tabs.find((t) => t.composerId && t.composerId === state.activeComposerId);

    const folders = state.folders ?? [];
    // Identify the folder by the finished agent's composer id rather than
    // `isCurrent`: when the relay is homed on the "Cursor Agents" overview no
    // folder is marked current, so the push would otherwise omit the folder.
    const targetComposerId = (activeTab && activeTab.composerId) || state.activeComposerId || '';
    let owner: CursorState['folders'][number] | undefined;
    let ownerAgent: FolderAgent | undefined;
    if (targetComposerId) {
      for (const f of folders) {
        const a = (f.agents ?? []).find((x) => x.composerId && x.composerId === targetComposerId);
        if (a) { owner = f; ownerAgent = a; break; }
      }
    }
    if (!owner) owner = folders.find((f) => f.isCurrent);
    const folderAgent = ownerAgent || (owner ? (owner.agents ?? []).find((a) => a.isActive) : undefined);

    const win = (state.windows ?? []).find((w) => w.id === state.activeWindowId);
    const winTitle = win && win.title && !/^cursor\s*agents$/i.test(win.title) ? win.title : '';

    const what = (activeTab && activeTab.title) || (folderAgent && folderAgent.title) || winTitle
      || (owner && owner.name) || '';
    const where = (owner && owner.name) || winTitle || '';
    if (!what) return '';
    return where && where !== what ? `${what} in ${where}` : what;
  }

  private scheduleFinishCheck(): void {
    if (this.pushFinishTimer) return;
    const finishForComposer = this.pushComposerId;
    this.pushFinishTimer = setTimeout(() => {
      this.pushFinishTimer = null;
      const state = this.stateManager.getCurrentState();
      if (!state.connected) return;
      if ((state.activeComposerId || '') !== finishForComposer) {
        this.pushWasWorking = this.aggregatePushSignals().working;
        return;
      }
      const { hasQ, hasA, working } = this.aggregatePushSignals();
      if (working) {
        this.pushWasWorking = true;
        return;
      }
      // Blocked on a question/approval is not a "finished" state.
      if (hasQ || hasA) {
        this.pushWasWorking = false;
        return;
      }
      this.pushWasWorking = false;
      const label = this.finishedPushLabel();
      void this.push(
        'Agent finished',
        label ? `${label} finished.` : 'The agent has finished working.',
        'cursor-finished',
        Relay.PUSH_VIBRATE_FINISHED,
        Relay.PUSH_TTL_FINISHED_SEC
      );
    }, Relay.PUSH_FINISH_SETTLE_MS);
  }

  private async push(
    title: string,
    body: string,
    tag?: string,
    vibrate?: number[],
    ttlSec?: number
  ): Promise<void> {
    const delivered = await this.webPush.send({
      title,
      body,
      tag,
      vibrate,
      ttl: ttlSec,
      // Epoch ms so the service worker can drop a push that sat in a queue
      // longer than its usefulness (defense in depth beyond the HTTP TTL).
      ts: Date.now(),
    });
    if (delivered > 0) {
      console.log(`[web-push] Sent "${title}" to ${delivered} subscription(s)`);
    }
  }
}
