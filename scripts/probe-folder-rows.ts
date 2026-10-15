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
    console.error('[probe-folder-rows] No Cursor windows found');
    process.exit(1);
  }
  const target = pages.find(p => p.title.toLowerCase().includes('overview')) ?? pages[0];
  console.log(`[probe-folder-rows] Connecting to "${target.title}"...`);

  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl);

  const result = await client.evaluate(`
    (() => {
      const out = [];
      for (const sec of document.querySelectorAll('section[data-sidebar-workspace-section-root]')) {
        const head = sec.querySelector('.ui-sidebar-section-head .ui-sidebar-label-row-title');
        const name = (head?.textContent || '').trim();
        const sectionId = sec.getAttribute('data-agent-drop-section-id') || '';
        const listContainer = sec.querySelector('.glass-sidebar-agent-list-container');
        const itemsInContainer = listContainer
          ? Array.from(listContainer.querySelectorAll('li.ui-sidebar-menu-item')).length
          : 0;
        const itemsInSection = Array.from(sec.querySelectorAll('li.ui-sidebar-menu-item')).length;
        const allItems = Array.from(sec.querySelectorAll('li')).length;
        out.push({
          name,
          sectionId,
          hasContainer: !!listContainer,
          itemsInContainer,
          itemsInSection,
          allLiInSection: allItems,
          expanded: sec.getAttribute('aria-expanded'),
          dataExpanded: sec.getAttribute('data-expanded'),
          collapsed: sec.getAttribute('data-collapsed'),
        });
      }
      return out;
    })()
  `) as Record<string, unknown>[];

  console.log(JSON.stringify(result, null, 2));
  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
