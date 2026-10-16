// Quick CDP probe: inspect folder section heads in the Cursor Agents sidebar.
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/6DCA998855F24AF276466FAA3FF0DC18');
let nextId = 1;
const pending = new Map();

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function call(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.error) { console.error('CDP error:', r.result.error); return null; }
  return r.result?.result?.value;
}

ws.on('open', async () => {
  const out = await evaluate(`
    (() => {
      const sections = Array.from(document.querySelectorAll('section[data-sidebar-workspace-section-root]'));
      return sections.map((s, i) => {
        const head = s.querySelector('.ui-sidebar-section-head');
        return {
          i,
          name: head?.querySelector('.ui-sidebar-label-row-title')?.textContent || '',
          sectionId: s.getAttribute('data-agent-drop-section-id') || '',
          headHTML: head ? head.outerHTML.substring(0, 1500) : '',
          headButtons: head ? Array.from(head.querySelectorAll('[role="button"], button, [data-sidebar-menu-button], .ui-sidebar-menu-button, [aria-label]')).map((b) => ({
            tag: b.tagName, cls: b.className && b.className.substring ? b.className.substring(0, 120) : '', aria: b.getAttribute('aria-label'), title: b.getAttribute('title'),
          })) : [],
        };
      });
    })()
  `);
  console.log(JSON.stringify(out, null, 2));
  ws.close();
  process.exit(0);
});

