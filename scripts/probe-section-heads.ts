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
    console.error('[probe-section-heads] No Cursor windows found');
    process.exit(1);
  }
  const target = pages.find(p => p.title.toLowerCase().includes('overview')) ?? pages[0];
  console.log(`[probe-section-heads] Connecting to "${target.title}"...`);

  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl);

  const result = await client.callFunction(() => {
    const out: Record<string, unknown>[] = [];

    // Dump every workspace section head: folder name + ALL buttons/links in
    // the head row + the section's own data attributes.
    const sections = Array.from(document.querySelectorAll('section[data-sidebar-workspace-section-root]'));
    for (const section of sections) {
      const head = section.querySelector('.ui-sidebar-section-head');
      const name = (head?.querySelector('.ui-sidebar-label-row-title')?.textContent || '').trim();
      const sectionId = section.getAttribute('data-agent-drop-section-id') || '';
      const headButtons: Record<string, unknown>[] = [];
      for (const b of Array.from(head?.querySelectorAll('button, [data-command-id], [role="button"], a') ?? [])) {
        headButtons.push({
          tag: b.tagName,
          dataCommandId: b.getAttribute('data-command-id'),
          ariaLabel: b.getAttribute('aria-label'),
          title: b.getAttribute('title'),
          classes: String(b.className || '').substring(0, 100),
          text: (b.textContent || '').trim().substring(0, 40),
        });
      }
      const agentCount = section.querySelectorAll('.glass-sidebar-agent-list-container li.ui-sidebar-menu-item').length;
      out.push({ kind: 'section-head', name, sectionId, agentCount, headButtons });
    }

    // Also dump global new-composer buttons outside sections
    for (const el of Array.from(document.querySelectorAll('[data-command-id]'))) {
      const id = el.getAttribute('data-command-id') || '';
      if (/composer|agent|chat/i.test(id) && /new|create|add/i.test(id)) {
        out.push({
          kind: 'global-new-composer',
          id,
          tag: el.tagName,
          ariaLabel: el.getAttribute('aria-label') || '',
          classes: String(el.className || '').substring(0, 100),
        });
      }
    }
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch(e => { console.error('[probe-section-heads]', e); process.exit(1); });
