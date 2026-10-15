import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import type { ServerConfig, SelectorConfig } from './types.js';

export function loadConfig(): ServerConfig {
  const preRegisteredRaw = process.env.TELEGRAM_ALLOWED_USERS ?? '';
  const preRegisteredUsers = preRegisteredRaw
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));

  const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');

  const certPath = (process.env.TLS_CERT_PATH ?? '').trim();
  const keyPath = (process.env.TLS_KEY_PATH ?? '').trim();
  // TLS is on only when explicitly enabled AND both PEM files are configured;
  // a half-configured pair would otherwise crash the server at startup.
  const tlsEnabled = process.env.TLS_ENABLED === 'true' && !!certPath && !!keyPath;

  return {
    cdpUrl: process.env.CDP_URL ?? 'http://127.0.0.1:9222',
    serverPort: parseInt(process.env.SERVER_PORT ?? '3000', 10),
    serverHost: process.env.SERVER_HOST ?? '127.0.0.1',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '300', 10),
    debounceMs: parseInt(process.env.DEBOUNCE_MS ?? '150', 10),
    selectorsPath: process.env.SELECTORS_PATH ?? './selectors.json',
    logLevel: (process.env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    webappPassword: process.env.WEBAPP_PASSWORD ?? '',
    windowTitleQualifier: process.env.WINDOW_TITLE_QUALIFIER !== 'false',
    dataDir,
    cursorStateDb: resolveCursorStateDb(),
    historyMaxMessages: Math.max(0, parseInt(process.env.HISTORY_MAX_MESSAGES ?? '2000', 10) || 0),
    webPush: {
      enabled: process.env.WEBPUSH_ENABLED !== 'false',
      subject: process.env.WEBPUSH_SUBJECT ?? 'mailto:cursorremote@localhost',
    },
    telegram: {
      enabled: process.env.TELEGRAM_ENABLED === 'true',
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      preRegisteredUsers,
      impl: (process.env.TELEGRAM_IMPL === 'raw' ? 'raw' : 'grammy') as 'grammy' | 'raw',
    },
    tls: {
      enabled: tlsEnabled,
      certPath,
      keyPath,
      caPath: (process.env.TLS_CA_PATH ?? '').trim(),
      passphrase: process.env.TLS_KEY_PASSPHRASE ?? '',
    },
    trustProxy: process.env.TRUST_PROXY === 'true',
  };
}

/**
 * Resolve the path to Cursor's global `state.vscdb` (the authoritative store of
 * full chat transcripts). Honors the CURSOR_STATE_DB override; otherwise tries
 * the platform default. Returns '' when no candidate exists, which disables
 * history loading rather than crashing the server.
 */
function resolveCursorStateDb(): string {
  const override = process.env.CURSOR_STATE_DB;
  if (override) return resolve(override);
  const candidates = [
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  ];
  return candidates.find((p) => existsSync(p)) ?? '';
}

export function loadSelectors(config: ServerConfig): SelectorConfig {
  const fullPath = resolve(config.selectorsPath);
  try {
    const raw = readFileSync(fullPath, 'utf-8');
    return JSON.parse(raw) as SelectorConfig;
  } catch (err) {
    console.warn(`[config] Could not load selectors from ${fullPath}, using defaults`);
    return getDefaultSelectors();
  }
}

function getDefaultSelectors(): SelectorConfig {
  return {
    chatContainer: {
      strategies: [
        "#workbench\\.parts\\.auxiliarybar",
        "div.composer-bar.editor",
        "[class*='composer-bar']",
        "[class*='composer-panel']",
        "[class*='chat-widget']",
      ],
    },
    approveButton: {
      strategies: [
        "button[aria-label*='Accept']",
        "button[aria-label*='Approve']",
        "button[aria-label*='Run']",
        "button[aria-label*='Allow']",
      ],
      textMatch: ['Accept', 'Approve', 'Run', 'Allow', 'Accept All'],
    },
    rejectButton: {
      strategies: [
        "button[aria-label*='Reject']",
        "button[aria-label*='Deny']",
        "button[aria-label*='Cancel']",
      ],
      textMatch: ['Reject', 'Deny', 'Cancel', 'Skip'],
    },
    chatInput: {
      strategies: [
        "textarea[class*='input']",
        "[contenteditable='true']",
        "[role='textbox']",
        "textarea",
      ],
    },
    agentStatus: {
      strategies: [
        "[class*='status']",
        "[class*='thinking']",
        "[class*='spinner']",
        "[class*='loading']",
      ],
    },
  };
}
