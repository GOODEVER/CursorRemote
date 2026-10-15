import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';
import { CdpClient } from '../src/server/cdp-client.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function discoverTargets(cdpUrl: string): Promise<CDPTarget[]> {
  const resp = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
  return resp.json() as Promise<CDPTarget[]>;
}

async function main() {
  const config = loadConfig();
  const pages = (await discoverTargets(config.cdpUrl)).filter(t => t.type === 'page' && t.url.includes('workbench'));
  if (pages.length === 0) {
    console.error('[probe-folders] No Cursor windows found');
    process.exit(1);
  }
  // Prefer the overview window (holds the agent sidebar)
  const target = pages.find(p => p.title.toLowerCase().includes('overview')) ?? pages[0];
  console.log(`[probe-folders] Connecting to "${target.title}"...`);

  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl);

  const result = await client.callFunction(() => {
    const out: Record<string, unknown>[] = [];

    // All elements with data-command-id containing new/create/composer
    for (const el of Array.from(document.querySelectorAll('[data-command-id]'))) {
      const id = el.getAttribute('data-command-id') || '';
      if (/new|create|add/i.test(id) && /composer|agent|chat/i.test(id)) {
        out.push({
          kind: 'data-command-id',
          id,
          tag: el.tagName,
          classes: String(el.className || '').substring(0, 120),
          ariaLabel: el.getAttribute('aria-label') || '',
          text: (el.textContent || '').trim().substring(0, 80),
        });
      }
    }

    // Folder rows: dump all buttons inside each sidebar row
    const rows = Array.from(document.querySelectorAll('.glass-sidebar-agent-list-container li.ui-sidebar-menu-item'));
    for (const li of rows) {
      const label = (li.querySelector('.ui-sidebar-menu-button-label')?.textContent || '').trim();
      const buttons: Record<string, unknown>[] = [];
      for (const b of Array.from(li.querySelectorAll('button, [data-command-id], a'))) {
        buttons.push({
          tag: b.tagName,
          dataCommandId: b.getAttribute('data-command-id'),
          ariaLabel: b.getAttribute('aria-label'),
          classes: String(b.className || '').substring(0, 120),
          text: (b.textContent || '').trim().substring(0, 40),
        });
      }
      out.push({ kind: 'sidebar-row', label: label.substring(0, 80), buttonCount: buttons.length, buttons });
    }
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  await client.close();
}

main().catch(e => { console.error('[probe-folders]', e); process.exit(1); });
