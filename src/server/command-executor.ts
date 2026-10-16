import type { CdpClient } from './cdp-client.js';
import type { SelectorConfig, CommandResult, PlanModelOption } from './types.js';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const FOCUS_DELAY_MS = 100;

// Cursor 3.8+ uses data-message-index; older builds use data-flat-index.
const MESSAGE_WRAPPER_SELECTOR = '[data-message-index], [data-flat-index]';

// Resolves the currently-open model picker menu element across Cursor versions.
// Older builds expose `[data-testid="model-picker-menu"]`; newer builds (~3.5.17)
// removed the testid and render the picker as a generic `[role="menu"]` opened
// via `.ui-model-picker__trigger`, so we cascade through several lookups.
// Stable across model-picker renders — Cursor's React 19 useId-generated IDs
// (`_r_ld_`, `_r_qm_`, …) change on every mount, so they round-trip badly as
// model identifiers. Treat anything matching this pattern as no-id and fall
// back to the synthetic `label::<text>` form.
const REACT_USE_ID_RE = /^_r_[a-z0-9]+_$/;

// Shared in-browser helpers for reading and clicking model-picker rows. Both
// the read path (`get_model_options`) and the write path (`set_model` /
// `set_plan_model`) use the same `collectModelItems()` / `pickModelById()`
// implementations so the round-trip is consistent — there's exactly one
// definition of "what counts as a model row" and "how to map an id back to a
// row." Inject as `${MODEL_ITEM_HELPERS_JS}` inside an evaluate().
export const MODEL_ITEM_HELPERS_JS = `
  const REACT_USE_ID_RE = ${REACT_USE_ID_RE.toString()};

  // Row label, excluding text from descendant <button> elements (each row has
  // an inner "Edit" button whose text would otherwise pollute the label).
  const labelOf = (el) => {
    const clone = el.cloneNode(true);
    for (const b of Array.from(clone.querySelectorAll('button'))) b.remove();
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  };

  // Returns the DOM id only if it's stable; React useId values round-trip badly.
  const stableIdOf = (el) => {
    const raw = el.id || '';
    if (!raw || REACT_USE_ID_RE.test(raw)) return '';
    return raw;
  };

  // Top-level rows under the menu — drops items contained inside another
  // candidate so per-row Edit buttons don't show up as separate "models."
  const modelRowsIn = (menu) => {
    if (!menu) return [];
    const raw = Array.from(menu.querySelectorAll('[id], [role="menuitem"], button, [data-testid]'));
    return raw.filter(item => !raw.some(other => other !== item && other.contains(item)));
  };

  const clickModelRow = (item) => {
    const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
    clickable.click();
  };

  const collectModelItems = (menu) => {
    const items = modelRowsIn(menu);
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const label = labelOf(item);
      if (!label) continue;
      // Skip pure action-button entries that survived the nesting filter
      // (defensive — e.g. floating Edit/Configure buttons not inside a row).
      if (/^(edit|configure|remove|delete|star)$/i.test(label)) continue;
      const stableId = stableIdOf(item);
      const key = stableId || label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
      const cls = clickable.className || item.className || '';
      const aria = clickable.getAttribute?.('aria-checked') || item.getAttribute?.('aria-checked') || '';
      const selected = /selected|active|checked/.test(cls) || aria === 'true';
      out.push({
        id: stableId || ('label::' + label),
        label,
        selected,
      });
    }
    return out;
  };

  // Finds and clicks the row whose id (or synthesized label::id) matches the
  // requested target. Targets can be: a real DOM id ("model-opus"), a
  // synthesized "label::<text>" (when the row has no stable id), an unstable
  // React useId ("_r_ld_"), or the bare label text. Returns true on success.
  const pickModelById = (menu, targetId) => {
    if (!menu || !targetId) return false;
    const isLabelId = targetId.startsWith('label::');
    const isUnstable = REACT_USE_ID_RE.test(targetId);
    const labelTarget = (isLabelId ? targetId.slice(7) : '').trim().toLowerCase();
    const targetLc = targetId.toLowerCase();
    const fuzzy = (isLabelId || isUnstable) ? '' : targetLc.replace(/[-_]/g, ' ');

    if (!isLabelId && !isUnstable) {
      const byId = document.getElementById(targetId);
      if (byId && (byId === menu || menu.contains(byId))) {
        clickModelRow(byId);
        return true;
      }
    }

    const rows = modelRowsIn(menu);
    // Pass 1: exact match (preferred — avoids "GPT-5" matching "GPT-5.5").
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      const stableId = stableIdOf(item);
      if (isLabelId || isUnstable) {
        if (labelLc === labelTarget || labelLc === targetLc) {
          clickModelRow(item);
          return true;
        }
      } else {
        if (stableId === targetId || ('label::' + label) === targetId) {
          clickModelRow(item);
          return true;
        }
      }
    }
    // Pass 2: fuzzy/substring fallback for label::-style targets, in case the
    // live row has extra text (e.g. a "Premium" badge, subtitle) beyond what
    // collectModelItems captured. Guarded by length to avoid partial matches
    // like "GPT-5" matching "GPT-5.5".
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      if (isLabelId || isUnstable) {
        if (labelTarget.length >= 4 && labelLc.includes(labelTarget)) {
          clickModelRow(item);
          return true;
        }
      } else if (fuzzy && labelLc.includes(fuzzy)) {
        clickModelRow(item);
        return true;
      }
    }
    return false;
  };
`;

// Back-compat alias for tests that imported the old name.
export const MODEL_ITEM_COLLECTOR_JS = MODEL_ITEM_HELPERS_JS;

// Inject as `${MODEL_MENU_LOOKUP_JS}` inside an evaluate; call `findModelMenu()`.
export const MODEL_MENU_LOOKUP_JS = `
  const findModelMenu = () => {
    const byTestId = document.querySelector('[data-testid="model-picker-menu"]');
    if (byTestId) return byTestId;
    const triggers = document.querySelectorAll(
      '.ui-model-picker__trigger[aria-expanded="true"],' +
      '.composer-unified-dropdown-model[aria-expanded="true"],' +
      '.composer-unified-dropdown[aria-expanded="true"]'
    );
    for (const t of Array.from(triggers)) {
      const controls = t.getAttribute('aria-controls');
      if (controls) {
        const byControls = document.getElementById(controls);
        if (byControls) return byControls;
      }
    }
    const openMenu = document.querySelector('[role="menu"][data-state="open"]');
    if (openMenu) return openMenu;
    const visibleMenus = document.querySelectorAll('[role="menu"]:not([hidden])');
    for (const m of Array.from(visibleMenus)) {
      const rect = m.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return m;
    }
    return null;
  };
`;

// Injected into evaluate() to obtain the workbench CommandService in a Cursor
// renderer. The service is reachable through the React props of a component that
// renders `uiContextMenuServices` — present in workspace windows (it holds a
// `commandService` with `executeCommand`). We DFS the React fiber tree from the
// container roots and cache the hit on `window.__cursorRemoteCommandService` so
// repeated calls are cheap. Returns the commandService object or null.
export const COMMAND_SERVICE_LOOKUP_JS = `
  const __getCommandService = () => {
    if (window.__cursorRemoteCommandService) return window.__cursorRemoteCommandService;
    const seen = new Set();
    const seeds = [];
    for (const el of document.querySelectorAll('*')) {
      for (const k of Object.keys(el)) {
        if (k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$')) seeds.push(el[k]);
      }
    }
    const stack = [...seeds];
    let n = 0;
    while (stack.length && n < 100000) {
      const f = stack.pop();
      if (!f || typeof f !== 'object' || seen.has(f)) continue;
      seen.add(f);
      n++;
      const mp = f.memoizedProps;
      if (mp && typeof mp === 'object') {
        const svcs = mp.uiContextMenuServices;
        if (svcs && typeof svcs.executeCommand === 'function') {
          window.__cursorRemoteCommandService = svcs;
          return svcs;
        }
        if (svcs && svcs.commandService && typeof svcs.commandService.executeCommand === 'function') {
          window.__cursorRemoteCommandService = svcs.commandService;
          return svcs.commandService;
        }
        if (mp.paletteConfig && typeof mp.paletteConfig.executeCommand === 'function') {
          window.__cursorRemoteCommandService = mp.paletteConfig;
          return mp.paletteConfig;
        }
      }
      if (f.child) stack.push(f.child);
      let s = f.sibling, i = 0;
      while (s && i < 2000) { stack.push(s); s = s.sibling; i++; }
    }
    return null;
  };
`;

export type ActionClickTargetResult = { element: Element } | { error: string };

const ACTION_BUTTON_SELECTOR = 'button, [role="button"], [class*="ui-button"], [data-click-ready]';

function normalizeActionLabel(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function elementLabelMatches(element: Element, expectedLabel: string): boolean {
  // Questionnaire option rows render letter + label ("A" + "Explore…"), so
  // whole-text equality can never pass; compare the dedicated label span.
  // Freeform ("Other") rows expose a label span reading "Other…" but the
  // client-facing label is always "Other", so check the freeform classes FIRST
  // — otherwise the trailing ellipsis breaks the match. Cursor's newer tray
  // uses `.ui-tray-option` with `.ui-tray-option__label` +
  // `questionnaire-freeform-option`.
  if (
    element.classList.contains('composer-questionnaire-toolbar-option-freeform')
    || element.classList.contains('questionnaire-freeform-option')
    || element.getAttribute('data-text-input') === 'true'
  ) {
    return normalizeActionLabel(expectedLabel) === 'other';
  }
  const optionLabel = element.querySelector('.composer-questionnaire-toolbar-option-label')
    ?? element.querySelector('.ui-tray-option__label');
  if (optionLabel) {
    return normalizeActionLabel(optionLabel.textContent) === normalizeActionLabel(expectedLabel);
  }
  const truncatedLabel = element.querySelector('span.truncate');
  if (truncatedLabel) {
    return normalizeActionLabel(truncatedLabel.textContent) === normalizeActionLabel(expectedLabel);
  }
  // Strip inert decorations (e.g. Cursor's tray shortcut glyph "⏎") so a
  // "Continue⏎" footer button still matches the "Continue" label.
  const clone = element.cloneNode(true) as Element;
  for (const deco of Array.from(clone.querySelectorAll('.ui-tray-footer__shortcut, .ui-tray-option__badge'))) {
    deco.remove();
  }
  return normalizeActionLabel(clone.textContent) === normalizeActionLabel(expectedLabel);
}

function isElementRoot(root: Document | Element): root is Element {
  return root.nodeType === 1;
}

function queryWithin(root: Document | Element, selector: string): Element | null {
  try {
    if (isElementRoot(root) && root.matches(selector)) return root;
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function firstSelectorSegment(selectorPath: string): string {
  return selectorPath.split('>')[0]?.trim() ?? '';
}

function actionSearchRoot(root: Document | Element, selectorPath: string): Document | Element {
  const firstSegment = firstSelectorSegment(selectorPath);
  if (!firstSegment) return root;
  return queryWithin(root, firstSegment) ?? root;
}

function buttonLikeCandidates(root: Document | Element): Element[] {
  const descendants = Array.from(root.querySelectorAll(ACTION_BUTTON_SELECTOR));
  if (isElementRoot(root) && root.matches(ACTION_BUTTON_SELECTOR)) {
    return [root, ...descendants.filter(el => el !== root)];
  }
  return descendants;
}

function matchingResolvedActionTarget(element: Element, expectedLabel: string): Element | null {
  const closest = element.closest(ACTION_BUTTON_SELECTOR);
  if (closest && elementLabelMatches(closest, expectedLabel)) return closest;
  if (element.matches(ACTION_BUTTON_SELECTOR) && elementLabelMatches(element, expectedLabel)) return element;

  for (const child of Array.from(element.querySelectorAll(ACTION_BUTTON_SELECTOR))) {
    if (elementLabelMatches(child, expectedLabel)) return child;
  }

  if (elementLabelMatches(element, expectedLabel)) return element;
  return null;
}

// Keep in sync with ACTION_CLICK_RESOLVER_JS below.
export function resolveActionClickTarget(
  root: Document | Element,
  selectorPath: string,
  expectedLabel: string
): ActionClickTargetResult {
  const resolved = queryWithin(root, selectorPath);
  if (resolved) {
    const matched = matchingResolvedActionTarget(resolved, expectedLabel);
    if (matched) return { element: matched };
  }

  const scope = actionSearchRoot(root, selectorPath);
  const matches = buttonLikeCandidates(scope)
    .filter(element => elementLabelMatches(element, expectedLabel));

  if (matches.length === 1) return { element: matches[0] };
  return { error: `action target not found (label: ${expectedLabel})` };
}

// Keep in sync with resolveActionClickTarget() above. Inject as
// `${ACTION_CLICK_RESOLVER_JS}` inside an evaluate().
export const ACTION_CLICK_RESOLVER_JS = `
  const ACTION_BUTTON_SELECTOR = 'button, [role="button"], [class*="ui-button"], [data-click-ready]';

  const normalizeActionLabel = (value) => (value || '').trim().toLowerCase();

  const elementLabelMatches = (element, expectedLabel) => {
    // Freeform ("Other") first — its label span reads "Other…" (trailing
    // ellipsis) while the client-facing label is always "Other".
    if (
      element.classList.contains('composer-questionnaire-toolbar-option-freeform')
      || element.classList.contains('questionnaire-freeform-option')
      || element.getAttribute('data-text-input') === 'true'
    ) {
      return normalizeActionLabel(expectedLabel) === 'other';
    }
    const optionLabel = element.querySelector('.composer-questionnaire-toolbar-option-label')
      || element.querySelector('.ui-tray-option__label');
    if (optionLabel) {
      return normalizeActionLabel(optionLabel.textContent) === normalizeActionLabel(expectedLabel);
    }
    const truncatedLabel = element.querySelector('span.truncate');
    if (truncatedLabel) {
      return normalizeActionLabel(truncatedLabel.textContent) === normalizeActionLabel(expectedLabel);
    }
    const clone = element.cloneNode(true);
    for (const deco of Array.from(clone.querySelectorAll('.ui-tray-footer__shortcut, .ui-tray-option__badge'))) {
      deco.remove();
    }
    return normalizeActionLabel(clone.textContent) === normalizeActionLabel(expectedLabel);
  };

  const queryWithin = (root, selector) => {
    try {
      if (root instanceof Element && root.matches(selector)) return root;
      return root.querySelector(selector);
    } catch {
      return null;
    }
  };

  const firstSelectorSegment = (selectorPath) => {
    const first = selectorPath.split('>')[0];
    return first ? first.trim() : '';
  };

  const actionSearchRoot = (root, selectorPath) => {
    const firstSegment = firstSelectorSegment(selectorPath);
    if (!firstSegment) return root;
    return queryWithin(root, firstSegment) || root;
  };

  const buttonLikeCandidates = (root) => {
    const descendants = Array.from(root.querySelectorAll(ACTION_BUTTON_SELECTOR));
    if (root instanceof Element && root.matches(ACTION_BUTTON_SELECTOR)) {
      return [root, ...descendants.filter(el => el !== root)];
    }
    return descendants;
  };

  const matchingResolvedActionTarget = (element, expectedLabel) => {
    const closest = element.closest(ACTION_BUTTON_SELECTOR);
    if (closest && elementLabelMatches(closest, expectedLabel)) return closest;
    if (element.matches(ACTION_BUTTON_SELECTOR) && elementLabelMatches(element, expectedLabel)) return element;

    for (const child of Array.from(element.querySelectorAll(ACTION_BUTTON_SELECTOR))) {
      if (elementLabelMatches(child, expectedLabel)) return child;
    }

    if (elementLabelMatches(element, expectedLabel)) return element;
    return null;
  };

  const resolveActionClickTarget = (root, selectorPath, expectedLabel) => {
    const resolved = queryWithin(root, selectorPath);
    if (resolved) {
      const matched = matchingResolvedActionTarget(resolved, expectedLabel);
      if (matched) return { element: matched };
    }

    const scope = actionSearchRoot(root, selectorPath);
    const matches = buttonLikeCandidates(scope)
      .filter(element => elementLabelMatches(element, expectedLabel));

    if (matches.length === 1) return { element: matches[0] };
    return { error: 'action target not found (label: ' + expectedLabel + ')' };
  };
`;

export class CommandExecutor {
  private selectors: SelectorConfig;
  private client: CdpClient | null = null;

  constructor(selectors: SelectorConfig) {
    this.selectors = selectors;
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  async sendMessage(commandId: string, text: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.chatInput.strategies;

      // Step 1: Find and focus the input element (evaluate only for DOM query + focus)
      const result = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          let input = null;
          let matchedSelector = '';
          for (const sel of strategies) {
            try {
              input = document.querySelector(sel);
              if (input) { matchedSelector = sel; break; }
            } catch {}
          }
          if (!input) return { ok: false, error: 'Chat input not found (tried ' + strategies.length + ' selectors)' };

          const info = input.tagName + '.' + Array.from(input.classList).join('.') + ' | sel=' + matchedSelector;
          input.scrollIntoView({ block: 'center', behavior: 'instant' });
          input.focus();
          input.click();
          return { ok: true, info };
        })()
      `) as { ok: boolean; error?: string; info?: string } | null;

      if (!result?.ok) {
        throw new Error(result?.error ?? 'Failed to focus input');
      }

      console.log(`[command-executor] Focused: ${result.info}`);
      // Focus settle: keep short — CDP input events arrive on an ordered
      // channel, so only the renderer's focus handling needs this beat.
      await sleep(FOCUS_DELAY_MS);

      // Step 2: Clear any existing text via Ctrl+A then Delete (CDP Input domain)
      await client.pressKey('a', 'KeyA', 65, 2); // 2 = Ctrl modifier
      await sleep(30);
      await client.pressKey('Backspace', 'Backspace', 8);
      await sleep(30);

      // Step 3: Insert text via CDP Input.insertText (native Chromium input pipeline)
      await client.typeText(text);
      console.log(`[command-executor] Text inserted via Input.insertText (${text.length} chars)`);
      await sleep(80);

      // Step 4: Submit with Enter via CDP Input.dispatchKeyEvent
      await client.pressKey('Enter', 'Enter', 13);
      console.log(`[command-executor] Enter pressed via CDP Input.dispatchKeyEvent`);

      const trimmedText = text.trim();
      if (trimmedText.length > 0) {
        // Verify submission by waiting until the composer no longer holds the
        // typed text (event-driven, with a cap) instead of a fixed 300ms sleep —
        // Cursor usually clears the composer well before the cap.
        await sleep(120);
        for (let attempt = 0; attempt < 4; attempt++) {
          const stillContainsTypedText = await client.evaluate(`
            (() => {
              const strategies = ${JSON.stringify(strategies)};
              const typedText = ${JSON.stringify(trimmedText)};
              let input = null;
              for (const sel of strategies) {
                try {
                  input = document.querySelector(sel);
                  if (input) break;
                } catch {}
              }
              if (!input) return false;
              const valueText = typeof input.value === 'string' ? input.value : '';
              const contentText = input.textContent ?? input.innerText ?? '';
              const currentText = (input.isContentEditable ? contentText : (valueText || contentText)).trim();
              return currentText.length > 0 && currentText.includes(typedText);
            })()
          `) as boolean;

          if (!stillContainsTypedText) break;
          const isMac = process.platform === 'darwin';
          await client.pressKey('Enter', 'Enter', 13, isMac ? 4 : 2);
          await sleep(120);
          console.log(`[command-executor] ${isMac ? 'Cmd' : 'Ctrl'}+Enter retry fired because composer still contained typed text`);
        }
      }
    });
  }

  /**
   * Submit whatever is currently in the composer (e.g. after a slash command
   * inserted text, or a freeform answer was typed) without clearing/resetting it.
   * `expectText` is used only to detect whether the composer still holds the text.
   */
  async submitComposer(commandId: string, expectText?: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.chatInput.strategies;

      await client.pressKey('Enter', 'Enter', 13);
      console.log('[command-executor] submitComposer: Enter pressed');

      const probe = (expectText ?? '').trim();
      if (probe.length === 0) return;

      for (let attempt = 0; attempt < 4; attempt++) {
        await sleep(150);
        const stillContainsTypedText = await client.evaluate(`
          (() => {
            const strategies = ${JSON.stringify(strategies)};
            const typedText = ${JSON.stringify(probe)};
            let input = null;
            for (const sel of strategies) {
              try { input = document.querySelector(sel); if (input) break; } catch {}
            }
            if (!input) return false;
            const valueText = typeof input.value === 'string' ? input.value : '';
            const contentText = input.textContent ?? input.innerText ?? '';
            const currentText = (input.isContentEditable ? contentText : (valueText || contentText)).trim();
            return currentText.length > 0 && currentText.includes(typedText);
          })()
        `) as boolean;

        if (!stillContainsTypedText) break;
        const isMac = process.platform === 'darwin';
        await client.pressKey('Enter', 'Enter', 13, isMac ? 4 : 2);
        console.log('[command-executor] submitComposer: Cmd/Ctrl+Enter retry fired');
      }
    });
  }

  async clickApproval(
    commandId: string,
    selectorPath: string
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await client.click(selectorPath);
    });
  }

  async approveAll(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const selector = await this.findApproveAllButton(client);
      if (!selector) {
        throw new Error('"Accept All" button not found');
      }
      await client.click(selector);
    });
  }

  async reject(
    commandId: string,
    selectorPath?: string
  ): Promise<CommandResult> {
    // Preferred: click the exact rejection control the extractor found.
    if (selectorPath) {
      const direct = await this.clickApproval(commandId, selectorPath);
      if (direct.ok) return direct;
      console.warn(`[command-executor] Reject via selector failed (${direct.error}); falling back`);
    }
    return this.withRetry(commandId, async (client) => {
      // Fallback: find a visible Skip/Reject/Deny/Cancel control in the chat area
      // and click it. Scoped to avoid menu triggers and the composer's send area.
      const clicked = await client.evaluate(`
        (() => {
          const wanted = /^(skip|reject|deny|cancel|no|decline)\\b/i;
          const isMenuTrigger = (b) => {
            const p = b.getAttribute('aria-haspopup');
            return p === 'menu' || p === 'true' || p === 'listbox';
          };
          const btns = Array.from(document.querySelectorAll('button, [role="button"], [data-click-ready]'));
          for (const b of btns) {
            if (isMenuTrigger(b)) continue;
            const label = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
            if (wanted.test(label)) {
              const r = b.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              b.scrollIntoView({ block: 'center', behavior: 'instant' });
              b.click();
              return { ok: true, label };
            }
          }
          return { ok: false };
        })()
      `) as { ok: boolean; label?: string } | null;
      if (clicked?.ok) {
        console.log(`[command-executor] Reject via fallback control: ${clicked.label}`);
        return;
      }
      // Last resort: Escape cancels a pending approval prompt in Cursor.
      await client.pressKey('Escape', 'Escape', 27);
      console.log('[command-executor] Reject via Escape (no explicit control found)');
    });
  }

  async scrollChatUp(commandId: string, times: number = 5): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      for (let i = 0; i < times; i++) {
        await client.evaluate(`
          (() => {
            const strategies = ${JSON.stringify(containerSelectors)};
            for (const sel of strategies) {
              try {
                const el = document.querySelector(sel);
                if (el) {
                  const scrollable = el.querySelector('[class*="scroll"]') || el;
                  scrollable.scrollTop = 0;
                  return true;
                }
              } catch {}
            }
            return false;
          })()
        `);
        await sleep(500);
      }
      console.log(`[command-executor] Scrolled chat up ${times} times`);
    });
  }

  async scrollChatToBottom(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(containerSelectors)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                const scrollable = el.querySelector('[class*="scroll"]') || el;
                scrollable.scrollTop = scrollable.scrollHeight;
                return true;
              }
            } catch {}
          }
          return false;
        })()
      `);
      console.log('[command-executor] Scrolled chat to bottom');
    });
  }

  async switchTab(
    commandId: string,
    tabTitle: string,
    _selectorPath?: string
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const clicked = await client.evaluate(`
        (() => {
          const title = ${JSON.stringify(tabTitle)};
          const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
          const target = norm(title);
          function cleanTabTitle(raw) {
            let t = (raw || '').trim().replace(/\\s+/g, ' ');
            t = t.replace(/(@[\\w./]+)+\\s*$/, '');
            return t.trim().substring(0, 120);
          }
          function glassCompositeForBtn(btn) {
            const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
            const rawAgent = (labelEl?.textContent || '').trim();
            if (!rawAgent) return { composite: '', agentOnly: '' };
            const group = btn.closest('.ui-sidebar-group');
            const gt = group?.querySelector('.ui-sidebar-group-label-title');
            const rawGroup = (gt?.textContent || '').trim();
            let composite = cleanTabTitle(rawAgent);
            if (rawGroup) {
              const g = cleanTabTitle(rawGroup);
              if (g) composite = (g + ' / ' + cleanTabTitle(rawAgent)).substring(0, 120);
            }
            return { composite: norm(composite), agentOnly: norm(rawAgent) };
          }
          const glassBtns = Array.from(document.querySelectorAll(
            '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn, ' +
            '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item .ui-sidebar-menu-button'
          ));
          if (glassBtns.length > 0) {
            const rows = glassBtns.map((btn) => {
              const el = btn.closest('.ui-sidebar-menu-button, [data-sidebar-menu-button]') || btn;
              const id = el.getAttribute('data-composer-id')
                || el.closest('[data-composer-id]')?.getAttribute('data-composer-id') || '';
              return { btn: el as HTMLElement, id, ...glassCompositeForBtn(el) };
            }).filter((r) => r.composite);
            const byComp = rows.filter((r) => r.composite === target);
            if (byComp.length === 1) {
              byComp[0].btn.click();
              return true;
            }
            const byAgent = rows.filter((r) => r.agentOnly === target);
            if (byAgent.length === 1) {
              byAgent[0].btn.click();
              return true;
            }
            if (byComp.length > 1 || byAgent.length > 1) {
              throw new Error('Ambiguous tab title for glass sidebar: ' + title);
            }
          }
          const cells = document.querySelectorAll('.agent-sidebar-cell');
          for (const cell of Array.from(cells)) {
            const titleEl = cell.querySelector('.agent-sidebar-cell-text');
            const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
            if (text === target) {
              cell.click();
              return true;
            }
          }
          for (const cell of Array.from(cells)) {
            const titleEl = cell.querySelector('.agent-sidebar-cell-text');
            const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
            if (text.startsWith(target) || target.startsWith(text)) {
              cell.click();
              return true;
            }
          }
          return false;
        })()
      `) as boolean;
      if (!clicked) throw new Error('Tab not found: ' + tabTitle);
      console.log(`[command-executor] Switched tab: ${tabTitle}`);
    });
  }

  /**
   * Open/switch the workspace window to a specific agent chat by its composer
   * id. Clicking the agent's sidebar row is the reliable path: it switches the
   * open chat even for existing agents that already have history. The workbench
   * `composer.openComposer` command is only a fallback — from the renderer it
   * can resolve successfully while silently doing nothing (observed live:
   * returns ok:true but leaves the previously open composer active).
   */
  async openFolderAgent(
    commandId: string,
    composerId?: string,
    tabTitle?: string,
    selectorPath?: string
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const target = (composerId ?? '').trim();

      // Preferred: click the matching sidebar row (by composer id, then title,
      // then selector path). This is what actually switches existing agents.
      const clicked = await this.clickFolderAgentRow(client, target, tabTitle, selectorPath);
      if (clicked) {
        console.log(`[command-executor] Opened composer via row click: ${tabTitle ?? target}`);
        return;
      }

      // Fallback: ask the workbench command service to open it by id.
      if (target) {
        const result = await client.evaluate(`
          (() => {
            ${COMMAND_SERVICE_LOOKUP_JS}
            const svc = __getCommandService();
            if (!svc) return { ok: false, error: 'command service not found' };
            try {
              const ret = svc.executeCommand('composer.openComposer', ${JSON.stringify(target)});
              if (ret && typeof ret.catch === 'function') {
                ret.catch(() => {});
              }
              return { ok: true };
            } catch (e) {
              return { ok: false, error: String(e) };
            }
          })()
        `) as { ok: boolean; error?: string } | null;

        if (result?.ok) {
          console.log(`[command-executor] Opened composer via command: ${target.substring(0, 8)}`);
          return;
        }
        console.warn(`[command-executor] composer.openComposer failed (${result?.error})`);
      }

      throw new Error(`Agent not found: ${tabTitle ?? composerId ?? '(unknown)'}`);
    });
  }

  /**
   * Click the agent sidebar row matching by composer id (React fiber `agentId`),
   * then by exact title, then by selector path. Returns whether a row was
   * clicked.
   */
  private async clickFolderAgentRow(
    client: CdpClient,
    composerId?: string,
    tabTitle?: string,
    selectorPath?: string
  ): Promise<boolean> {
    return await client.evaluate(`
      (() => {
        const wantId = ${JSON.stringify((composerId ?? '').trim())};
        const title = ${JSON.stringify((tabTitle ?? '').trim())};
        const selectorPath = ${JSON.stringify(selectorPath ?? '')};
        const norm = (s) => (s || '').trim().replace(/\\s+/g, ' ').toLowerCase();
        const wantTitle = norm(title);

        const agentIdFromRow = (li) => {
          const attrId = li.getAttribute('data-composer-id')
            || li.querySelector('[data-composer-id]')?.getAttribute('data-composer-id')
            || '';
          if (attrId) return attrId;
          try {
            const fiberKey = Object.keys(li).find((k) => k.startsWith('__reactFiber$'));
            let fiber = fiberKey ? li[fiberKey] : null;
            let depth = 0;
            while (fiber && depth < 20) {
              const p = fiber.memoizedProps;
              if (p && typeof p.agentId === 'string' && p.agentId) return p.agentId;
              fiber = fiber.return || null;
              depth++;
            }
          } catch {}
          return '';
        };

        const rowLabel = (li) => {
          const el = li.querySelector('.ui-sidebar-menu-button-label');
          return norm(el ? el.textContent : li.textContent);
        };

        const clickRow = (li) => {
          const btn = li.querySelector('.ui-sidebar-menu-button')
            || li.querySelector('[data-sidebar-menu-button]')
            || li.querySelector('[role="button"]')
            || li;
          btn.scrollIntoView({ block: 'center', behavior: 'instant' });
          btn.click();
          return true;
        };

        const rows = Array.from(document.querySelectorAll('.glass-sidebar-agent-list-container li.ui-sidebar-menu-item'));

        // 1) Match by composer id.
        if (wantId) {
          for (const li of rows) {
            if (agentIdFromRow(li) === wantId) return clickRow(li);
          }
        }
        // 2) Match by exact title.
        if (wantTitle) {
          for (const li of rows) {
            if (rowLabel(li) === wantTitle) return clickRow(li);
          }
        }
        // 3) Match by selector path.
        if (selectorPath) {
          try {
            const el = document.querySelector(selectorPath.split('>')[0].trim());
            if (el) return clickRow(el);
          } catch {}
        }
        return false;
      })()
    `) as boolean;
  }

  async newChat(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.newChatButton?.strategies ?? [];
      const result = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) { el.click(); return true; }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!result) throw new Error('New Chat button not found');
      console.log(`[command-executor] New chat created`);
    });
  }

  /**
   * Create a new agent inside a specific folder section of Cursor's agent
   * overview. Clicks that section's "+" (New Agent) button.
   *
   * The "+" is hover-mounted: it lives in a `.ui-sidebar-menu-button-actions`
   * wrapper Cursor keeps at `display:none; opacity:0; pointer-events:none` until
   * the section row is actually hovered. Synthetic `MouseEvent`s cannot turn on
   * CSS `:hover`, so the old dispatchEvent + `.click()` approach left the button
   * hidden and the click a no-op — creating an agent silently did nothing. We
   * reveal it with a native CDP mouse move and click it with native CDP mouse
   * events, mirroring the composer-queue action flow.
   */
  async createFolderAgent(
    commandId: string,
    sectionId: string,
    folderName: string
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      // Re-used by every pass so the section is re-resolved after any re-render
      // caused by hovering.
      const findSectionJs = `
        (() => {
          const sectionId = ${JSON.stringify(sectionId)};
          const folderName = ${JSON.stringify(folderName.trim().toLowerCase())};
          const norm = (s) => (s || '').trim().toLowerCase();
          // Locate the workspace section by drop-section id, falling back to
          // the section header title when the id is synthesized (folder:<name>).
          if (sectionId) {
            const byId = document.querySelector('section[data-agent-drop-section-id="' + CSS.escape(sectionId) + '"]');
            if (byId) return byId;
          }
          for (const sec of document.querySelectorAll('section[data-sidebar-workspace-section-root]')) {
            const head = sec.querySelector('.ui-sidebar-section-head .ui-sidebar-label-row-title');
            if (head && norm(head.textContent) === folderName) return sec;
          }
          return null;
        })()
      `;

      // The section head is both the hover target and the drop target. Its
      // center reveals the actions; its far end is where they mount.
      const headBox = await client.evaluate(`
        (() => {
          const section = ${findSectionJs};
          if (!section) return null;
          const head = section.querySelector('.ui-sidebar-section-head') || section;
          head.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = head.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return null;
          return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            endX: Math.round(r.right - 14),
          };
        })()
      `) as { x: number; y: number; endX: number } | null;
      if (!headBox) {
        throw new Error(`Could not create agent in "${folderName}": folder not found`);
      }

      const findButtonJs = `
        (() => {
          const section = ${findSectionJs};
          if (!section) return { error: 'section disappeared' };
          let btn = null;
          for (const b of section.querySelectorAll('button, [role="button"], a')) {
            const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-state') || '')).trim();
            if (/new agent|new task/i.test(label)) { btn = b; break; }
            if (/(section-head|label-row).*action|plus|add/i.test(b.className || '')) { btn = b; }
          }
          if (!btn) {
            const btns = Array.from(section.querySelectorAll('.ui-sidebar-section-head button, .ui-sidebar-section-head [role="button"]'));
            if (btns.length > 0) btn = btns[btns.length - 1];
          }
          if (!btn) return { error: 'new agent button not found' };
          const r = btn.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return { error: 'new agent button not revealed' };
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()
      `;

      // Reveal the hover-mounted "+" with a NATIVE mouse move. Synthetic
      // MouseEvents cannot turn on CSS :hover, which is why the previous
      // dispatchEvent + .click() approach was a silent no-op. Probe-verified:
      // synthetic hover+click leaves the agent count unchanged; native
      // hover+click adds a row. Try the head center, then its far end.
      await client.hoverAtCoords(headBox.x, headBox.y);
      await sleep(150);

      let btnBox = await client.evaluate(findButtonJs) as { x?: number; y?: number; error?: string } | null;
      if (!btnBox || btnBox.x === undefined) {
        await client.hoverAtCoords(headBox.endX, headBox.y);
        await sleep(150);
        btnBox = await client.evaluate(findButtonJs) as { x?: number; y?: number; error?: string } | null;
      }
      if (!btnBox || btnBox.x === undefined || btnBox.y === undefined) {
        throw new Error(`Could not create agent in "${folderName}": ${btnBox?.error ?? 'new agent button not revealed'}`);
      }

      await client.clickAtCoords(btnBox.x, btnBox.y);
      console.log(`[command-executor] New agent created in folder "${folderName}"`);
    });
  }

  /**
   * Archive (or unarchive) a single agent row in Cursor's agent overview.
   *
   * Cursor mounts an Archive button per row inside `.ui-sidebar-menu-button-actions`,
   * but only while the row is hovered (`display:none; opacity:0; pointer-events:none`
   * otherwise). Like the section "+" and the composer queue actions, synthetic
   * MouseEvents cannot turn on CSS `:hover`, so we must move the real pointer with
   * native CDP input, re-read the button's live box, then click it natively.
   *
   * Archive is reached through the row's own handler, not a workbench command, so
   * this is the only faithful path. When the agent is still running Cursor first
   * raises a destructive "Archive running agent?" confirmation; we accept it so the
   * action is not left half-done (the app itself treats this as one gesture). Rows
   * listing only archived agents expose "Unarchive" instead, which we honor so the
   * same button doubles as restore.
   */
  async archiveFolderAgent(
    commandId: string,
    composerId: string,
    tabTitle: string,
    action: 'archive' | 'unarchive' = 'archive'
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const wantId = (composerId ?? '').trim();
      const wantTitle = (tabTitle ?? '').trim();
      if (!wantId && !wantTitle) throw new Error('Missing composerId/tabTitle for archive');

      const norm = `(s) => (s || '').trim().replace(/\\s+/g, ' ').toLowerCase()`;

      /**
       * Turn Cursor's "archived" sidebar filter on/off by calling the sidebar's
       * `onSidebarSettingsChange` prop. Archived rows are otherwise not mounted,
       * so there is nothing to click for an unarchive without this. Returns the
       * filter's prior state so the caller can restore it.
       */
      const setArchivedFilterJs = (want: boolean) => `
        (() => {
          const want = ${want ? 'true' : 'false'};
          const seeds = [];
          for (const el of document.querySelectorAll('*')) {
            for (const k of Object.keys(el)) {
              if (k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$')) seeds.push(el[k]);
            }
          }
          const seen = new Set(); const stack = [...seeds]; let n = 0;
          while (stack.length && n < 120000) {
            const f = stack.pop();
            if (!f || typeof f !== 'object' || seen.has(f)) continue;
            seen.add(f); n++;
            const mp = f.memoizedProps;
            if (mp && typeof mp === 'object' && mp.sidebarSettings && typeof mp.onSidebarSettingsChange === 'function') {
              let prev = null;
              try {
                prev = Array.isArray(mp.sidebarSettings.filter && mp.sidebarSettings.filter.show)
                  ? mp.sidebarSettings.filter.show.includes('archived') : false;
                const next = JSON.parse(JSON.stringify(mp.sidebarSettings));
                const show = new Set(Array.isArray(next.filter && next.filter.show) ? next.filter.show : []);
                if (want) show.add('archived'); else show.delete('archived');
                next.filter = Object.assign({}, next.filter, { show: Array.from(show) });
                mp.onSidebarSettingsChange(next);
                return { ok: true, prev };
              } catch (e) { return { ok: false, error: String(e), prev }; }
            }
            if (f.child) stack.push(f.child);
            if (f.sibling) stack.push(f.sibling);
          }
          return { ok: false, error: 'sidebar settings node not found', prev: null };
        })()
      `;

      // Locate the row by composer id first, then exact title. Re-evaluated on
      // every pass since the sidebar re-renders while we hover.
      const findRowJs = `
        (() => {
          const wantId = ${JSON.stringify(wantId)};
          const wantTitle = ${JSON.stringify(wantTitle.replace(/\s+/g, ' ').toLowerCase())};
          const norm = ${norm};
          const agentIdFromRow = (li) => {
            const attrId = li.getAttribute('data-composer-id')
              || li.querySelector('[data-composer-id]')?.getAttribute('data-composer-id') || '';
            if (attrId) return attrId;
            try {
              const key = Object.keys(li).find(k => k.startsWith('__reactFiber$'));
              let fiber = key ? li[key] : null;
              let depth = 0;
              while (fiber && depth < 20) {
                const p = fiber.memoizedProps;
                if (p && typeof p.agentId === 'string' && p.agentId) return p.agentId;
                fiber = fiber.return || null;
                depth++;
              }
            } catch {}
            return '';
          };
          const rows = Array.from(document.querySelectorAll('li.ui-sidebar-menu-item'));
          const label = (li) => norm(li.querySelector('.ui-sidebar-menu-button-label')?.textContent || li.textContent);
          if (wantId) { for (const li of rows) if (agentIdFromRow(li) === wantId) return li; }
          if (wantTitle) { for (const li of rows) if (label(li) === wantTitle) return li; }
          return null;
        })()
      `;

      const rowBox = await client.evaluate(`
        (() => {
          const row = ${findRowJs};
          if (!row) return null;
          row.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = row.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return null;
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()
      `) as { x: number; y: number } | null;

      // For unarchive the row is normally hidden by Cursor's archived filter, so
      // reveal archived rows first and remember the prior setting to restore.
      let prevArchivedFilter: boolean | null = null;
      if (!rowBox && action === 'unarchive') {
        const applied = await client.evaluate(setArchivedFilterJs(true)) as
          { ok: boolean; prev: boolean | null; error?: string } | null;
        if (applied && applied.ok) {
          prevArchivedFilter = applied.prev;
          await sleep(500);
        }
      }

      const resolvedRowBox = rowBox ?? await client.evaluate(`
        (() => {
          const row = ${findRowJs};
          if (!row) return null;
          row.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = row.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return null;
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()
      `) as { x: number; y: number } | null;

      if (!resolvedRowBox) {
        if (prevArchivedFilter !== null) await client.evaluate(setArchivedFilterJs(prevArchivedFilter));
        throw new Error(`Agent row not found: ${wantTitle || wantId}`);
      }

      // Reveal the hover-mounted actions with a native pointer move.
      await client.hoverAtCoords(resolvedRowBox.x, resolvedRowBox.y);
      await sleep(200);

      const wanted = action === 'unarchive'
        ? ['unarchive', 'restore']
        : ['archive'];
      const btnBox = await client.evaluate(`
        (() => {
          const row = ${findRowJs};
          if (!row) return { error: 'row disappeared' };
          const wanted = ${JSON.stringify(wanted)};
          const btns = Array.from(row.querySelectorAll('.ui-sidebar-menu-button-actions button'));
          for (const b of btns) {
            const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
            if (!wanted.includes(aria)) continue;
            const r = b.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), aria };
          }
          return { error: 'action button not revealed', present: btns.map(b => b.getAttribute('aria-label')) };
        })()
      `) as { x?: number; y?: number; aria?: string; error?: string; present?: string[] } | null;
      if (!btnBox || btnBox.x === undefined || btnBox.y === undefined) {
        const present = btnBox?.present?.length ? ` (found: ${btnBox.present.join(', ')})` : '';
        throw new Error(`${btnBox?.error ?? 'archive button not found'}${present}`);
      }

      await client.clickAtCoords(btnBox.x, btnBox.y);

      // Everything past the destructive click is best-effort: a transient CDP
      // hiccup here must NOT bubble up, because `withRetry` would re-run the
      // whole action and archive whatever row now occupies that spot.
      try {
        // Archiving a still-running agent raises a destructive confirm. Accept it
        // so the command reports the true outcome instead of a stale row.
        await sleep(500);
        const confirmLabel = action === 'unarchive' ? 'Unarchive' : 'Archive';
        const confirmBox = await client.evaluate(`
          (() => {
            const want = ${JSON.stringify(action === 'unarchive' ? 'Unarchive' : 'Archive')};
            for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
              const r = d.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              for (const b of d.querySelectorAll('button')) {
                const text = (b.textContent || '').replace(/\\s+/g, ' ').trim();
                if (!text.toLowerCase().startsWith(want.toLowerCase())) continue;
                const br = b.getBoundingClientRect();
                return { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2) };
              }
            }
            return null;
          })()
        `) as { x: number; y: number } | null;
        if (confirmBox) {
          await client.clickAtCoords(confirmBox.x, confirmBox.y);
          console.log(`[command-executor] Confirmed ${confirmLabel} for running agent`);
        }

        // Leave the sidebar filter as we found it: an unarchive only revealed the
        // archived rows to reach the button, and should not permanently change how
        // the user's sidebar is filtered.
        if (prevArchivedFilter !== null) {
          await sleep(300);
          await client.evaluate(setArchivedFilterJs(prevArchivedFilter));
        }
      } catch (err) {
        console.warn(`[command-executor] Post-archive cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      console.log(`[command-executor] ${action === 'unarchive' ? 'Unarchived' : 'Archived'} agent "${wantTitle || wantId}"`);
    });
  }

  async setMode(commandId: string, modeId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.modeDropdown?.strategies ?? [];

      // Click the dropdown trigger to open the menu
      const opened = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) { el.click(); return true; }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!opened) throw new Error('Mode dropdown not found');

      await sleep(250);

      // Click the mode item whose ID ends with the modeId
      const selected = await client.evaluate(`
        (() => {
          const modeId = ${JSON.stringify(modeId)};
          const items = document.querySelectorAll('[id*="composer-mode-"][id$="-' + modeId + '"]');
          for (const item of Array.from(items)) {
            const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
            clickable.click();
            return true;
          }
          return false;
        })()
      `) as boolean;
      if (!selected) throw new Error(`Mode "${modeId}" not found in dropdown`);
      console.log(`[command-executor] Mode set to: ${modeId}`);
    });
  }

  async clickAction(commandId: string, selectorPath: string, expectedLabel?: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      if (expectedLabel === undefined) {
        await client.click(selectorPath);
        console.log(`[command-executor] Clicked action: ${selectorPath.substring(0, 60)}`);
        return;
      }

      const result = await client.evaluate(`
        (() => {
          ${ACTION_CLICK_RESOLVER_JS}

          const selectorPath = ${JSON.stringify(selectorPath)};
          const expectedLabel = ${JSON.stringify(expectedLabel)};
          const target = resolveActionClickTarget(document, selectorPath, expectedLabel);
          if (!target.element) return { ok: false, error: target.error };

          target.element.scrollIntoView({ block: 'center', behavior: 'instant' });
          target.element.click();
          return { ok: true };
        })()
      `) as { ok: boolean; error?: string } | null;

      if (!result?.ok) {
        throw new Error(result?.error ?? `action target not found (label: ${expectedLabel})`);
      }
      console.log(`[command-executor] Clicked action: ${selectorPath.substring(0, 60)} (${expectedLabel})`);
    });
  }

  /**
   * Act on a queued (not-yet-sent) message in the newer `.ui-tray--queued` UI.
   * Its per-row buttons ("Send now" = `data-queue-action="steer"`, Edit,
   * Remove) are mounted only while the row is hovered/focused, so they cannot
   * be clicked via a static selector. We read the row's live viewport box,
   * move the real mouse pointer onto it to reveal the buttons, re-read the
   * button's box, then click it natively.
   */
  async queueRowAction(
    commandId: string,
    queueItemId: string,
    action: 'send' | 'remove',
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      // Match the row by attribute value inside the page (CSS.escape is not
      // available in Node), so ids with quotes/brackets are handled safely.
      const findRowJs = `
        (() => {
          const id = ${JSON.stringify(queueItemId)};
          const all = document.querySelectorAll('[data-queue-item-id]');
          for (const el of all) {
            if (el.getAttribute('data-queue-item-id') === id) return el;
          }
          return null;
        })()
      `;
      const rowBox = await client.evaluate(`
        (() => {
          const row = ${findRowJs};
          if (!row) return null;
          row.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = row.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return null;
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()
      `) as { x: number; y: number } | null;
      if (!rowBox) throw new Error(`Queue row not found: ${queueItemId}`);

      // Reveal the hover-mounted action buttons.
      await client.hoverAtCoords(rowBox.x, rowBox.y);
      await sleep(120);

      const wanted = action === 'send' ? ['steer', 'send'] : ['remove'];
      const btnBox = await client.evaluate(`
        (() => {
          const row = ${findRowJs};
          if (!row) return { error: 'row disappeared' };
          const wanted = ${JSON.stringify(wanted)};
          for (const a of wanted) {
            const btn = row.querySelector('[data-queue-action="' + a + '"]');
            if (!btn) continue;
            const r = btn.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          const present = Array.from(row.querySelectorAll('[data-queue-action]')).map(b => b.getAttribute('data-queue-action'));
          return { error: 'action button not revealed', present };
        })()
      `) as { x?: number; y?: number; error?: string; present?: string[] } | null;
      if (!btnBox || btnBox.x === undefined || btnBox.y === undefined) {
        throw new Error(btnBox?.error ?? `Queue action button not found (${action})`);
      }

      await client.clickAtCoords(btnBox.x, btnBox.y);
      console.log(`[command-executor] Queue ${action}: row ${queueItemId.substring(0, 8)}`);
    });
  }

  /**
   * Focus the composer and open the `/` slash-command tray, then read its rows.
   * Used to mirror Cursor's slash menu on the phone. The menu stays open in the
   * host composer; the client either picks a row (clickSlashCommand) or cancels
   * (cancelSlashMenu).
   *
   * `query` narrows the tray the way typing in Cursor would. Cursor only ever
   * renders the first ~14 rows and the tray has no scrollbar, so a filter is the
   * ONLY way to reach the rest of the command set — we type `/<query>` into the
   * composer and Cursor re-ranks its own matches (label + description).
   */
  async getSlashMenu(commandId: string, query = ''): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      await this.openSlashTray(client, query);
      return this.readSlashOptions(client);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  /** True while Cursor's `/` tray is mounted in the composer. */
  private async slashTrayOpen(client: CdpClient): Promise<boolean> {
    const open = await client.evaluate(`
      (() => document.querySelector('div[role="listbox"][aria-label="Slash commands"]') !== null)()
    `) as boolean;
    return !!open;
  }

  /**
   * Bring the composer to a single `/<query>` and leave the tray open. Cursor
   * pivots the tray on the composer's leading character, so a stray "/" or left-
   * over text would turn our "/" into "//" and keep the tray shut. If the tray
   * is already open at the exact request we want, this is a no-op (cheap for the
   * common "user is just scrolling the list" case).
   */
  private async openSlashTray(client: CdpClient, query: string): Promise<void> {
    // Keep the query conservative: Cursor only matches on the command token, so
    // strip anything that isn't a token character before typing it.
    const wanted = (query || '').replace(/[^\w-]/g, '').slice(0, 40);
    const desired = '/' + wanted;

    const alreadyOpen = await this.slashTrayOpen(client);
    if (alreadyOpen) {
      const current = await this.readComposerText(client);
      if (current === desired) return;
    }

    // Only clear when there is something to clear: an already-empty composer
    // just receives the "/query" (a needless select-all + Backspace here would
    // also emit a stray keystroke the tests/replay depend on not seeing).
    const current = await this.readComposerText(client);
    if (current.length > 0) {
      await this.clearComposer(client);
    }
    await this.focusComposer(client);
    await client.typeText(desired);
    // Cursor debounces its filter; a query needs a beat longer than a bare "/".
    await sleep(wanted ? 550 : 450);
  }

  /** Read the rows currently rendered in the `/` tray (empty when closed). */
  private async readSlashOptions(client: CdpClient): Promise<unknown> {
    return client.evaluate(`
      (() => {
        const list = document.querySelector('div[role="listbox"][aria-label="Slash commands"]');
        if (!list) return { open: false, options: [] };
        const rows = Array.from(list.querySelectorAll('button[role="option"]'));
        const options = rows.map((el, i) => {
          const textSpan = el.children.length >= 2 ? el.children[1] : el;
          const parts = [];
          for (const node of Array.from(textSpan.querySelectorAll('span, div'))) {
            const t = (node.textContent || '').trim();
            if (t && parts[parts.length - 1] !== t) parts.push(t);
          }
          const directText = Array.from(textSpan.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => (n.textContent || '').trim())
            .filter(Boolean)
            .join(' ');
          const label = (directText || parts[0] || (el.textContent || '').trim()).slice(0, 80);
          const description = (parts[parts.length - 1] || '').slice(0, 160);
          return {
            id: label ? label.toLowerCase().replace(/\\s+/g, '-') : ('slash-' + i),
            label,
            description: description === label ? '' : description,
            selected: el.getAttribute('aria-selected') === 'true',
            index: i + 1,
          };
        });
        return { open: true, options };
      })()
    `);
  }

  /**
   * Click a row in the open `/` slash tray. `slashId` matches the synthesized id
   * (lowercased label); `slashIndex` is a 1-based fallback. If the tray is not
   * open (e.g. a poll cleared it), it is reopened first — restoring `query` so
   * the same filtered list the client is looking at is what gets clicked.
   */
  async clickSlashCommand(commandId: string, slashId?: string, slashIndex?: number, query = ''): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      await this.openSlashTray(client, query);

      const clicked = await client.evaluate(`
        (() => {
          const list = document.querySelector('div[role="listbox"][aria-label="Slash commands"]');
          if (!list) return { ok: false, error: 'slash menu not open' };
          const rows = Array.from(list.querySelectorAll('button[role="option"]'));
          if (rows.length === 0) return { ok: false, error: 'slash menu empty' };

          const wantId = ${JSON.stringify(slashId ?? '')};
          const wantIndex = ${JSON.stringify(typeof slashIndex === 'number' ? slashIndex : null)};

          const labelOf = (el) => {
            const textSpan = el.children.length >= 2 ? el.children[1] : el;
            const parts = [];
            for (const node of Array.from(textSpan.querySelectorAll('span, div'))) {
              const t = (node.textContent || '').trim();
              if (t && parts[parts.length - 1] !== t) parts.push(t);
            }
            const directText = Array.from(textSpan.childNodes)
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => (n.textContent || '').trim())
              .filter(Boolean)
              .join(' ');
            return (directText || parts[0] || (el.textContent || '').trim()).slice(0, 80);
          };

          let target = null;
          if (wantId) {
            for (const el of rows) {
              const id = labelOf(el).toLowerCase().replace(/\\s+/g, '-');
              if (id === wantId) { target = el; break; }
            }
          }
          if (!target && wantIndex && wantIndex >= 1 && wantIndex <= rows.length) {
            target = rows[wantIndex - 1];
          }
          if (!target) return { ok: false, error: 'slash command not found' };

          target.scrollIntoView({ block: 'center', behavior: 'instant' });
          target.click();
          return { ok: true, label: labelOf(target) };
        })()
      `) as { ok: boolean; error?: string; label?: string } | null;

      if (!clicked?.ok) throw new Error(clicked?.error ?? 'slash command click failed');
      console.log(`[command-executor] Slash command clicked: ${clicked?.label ?? slashId ?? slashIndex}`);

      // Give Cursor a beat to apply the command (mode change or token insert),
      // then read back whatever now sits in the composer.
      await sleep(300);
      const composerText = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(this.selectors.chatInput.strategies)};
          let input = null;
          for (const sel of strategies) {
            try { input = document.querySelector(sel); if (input) break; } catch {}
          }
          if (!input) return '';
          const valueText = typeof input.value === 'string' ? input.value : '';
          const contentText = input.textContent ?? input.innerText ?? '';
          return (input.isContentEditable ? contentText : (valueText || contentText)).trim();
        })()
      `) as string;

      return { composerText, label: clicked?.label ?? '' };
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  /** Close the `/` tray and clear the stray "/" so nothing is left in the composer. */
  async cancelSlashMenu(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await client.pressKey('Escape', 'Escape', 27);
      await sleep(80);
      await client.pressKey('a', 'KeyA', 65, 2);
      await sleep(50);
      await client.pressKey('Backspace', 'Backspace', 8);
      console.log('[command-executor] Slash menu cancelled');
    });
  }

  /**
   * Fill the freeform ("Other") questionnaire answer without sending.
   *
   * Cursor mounts its rich-text editor (`.tiptap.ProseMirror`, role=combobox)
   * INSIDE the option row only AFTER the row has been clicked — it does not
   * exist in the DOM at extraction time. So `selectorPath` is the stable option
   * ROW; we click it first (selecting "Other"), wait for the editor to mount,
   * then focus the editor and insert the text. The client submits afterwards by
   * pressing Continue.
   */
  async setAnswerText(commandId: string, selectorPath: string, text: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      // 1) Focus an editor already mounted in the row (the client's option
      //    click normally mounts it). Only click to mount if it is missing —
      //    re-clicking an already-selected row risks toggling it off.
      const focusRow = `
        (() => {
          const row = document.querySelector(${JSON.stringify(selectorPath)});
          if (!row) return 'missing';
          const editor = row.querySelector('.tiptap.ProseMirror, [contenteditable="true"], textarea, input, [role="textbox"], [role="combobox"]');
          if (!editor) return 'no-editor';
          editor.scrollIntoView({ block: 'center', behavior: 'instant' });
          editor.focus();
          editor.click();
          return (document.activeElement === editor || row.contains(document.activeElement)) ? 'ok' : 'unfocused';
        })()
      `;
      let state = (await client.evaluate(focusRow)) as string;
      if (state === 'missing') throw new Error('freeform option row not found');
      if (state !== 'ok') {
        // Editor not mounted yet — select the option, then poll for the editor.
        await client.click(selectorPath);
        await sleep(120);
        for (let attempt = 0; attempt < 8 && state !== 'ok'; attempt++) {
          state = (await client.evaluate(focusRow)) as string;
          if (state !== 'ok') await sleep(120);
        }
      }
      if (state !== 'ok') throw new Error('freeform answer editor did not appear in option row');

      await sleep(80);
      await client.typeText(text);
      console.log(`[command-executor] Answer text inserted (${text.length} chars)`);
    });
  }

  /** Press the composer's stop control (or a running tool's Stop) to abort the current turn. */
  async stopGeneration(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const stopped = await client.evaluate(`
        (() => {
          // 1) Composer send↔stop toggle / dedicated Stop generation control.
          const byAria = document.querySelector('button[aria-label="Stop generation"]');
          if (byAria) { byAria.scrollIntoView({ block: 'center', behavior: 'instant' }); byAria.click(); return true; }
          // 2) Cursor's live tool "Stop command" control — present for the whole turn.
          const toolStop = document.querySelector('.ui-shell-tool-call__glass-stop');
          if (toolStop) { toolStop.scrollIntoView({ block: 'center', behavior: 'instant' }); toolStop.click(); return true; }
          // 3) Fallbacks across Cursor builds.
          for (const sel of ['.ui-prompt-input-submit-button[aria-label*="Stop"]', 'button[aria-label*="Stop"]', '[data-command-id*="stop"]', '[data-testid*="stop"]']) {
            const el = document.querySelector(sel);
            if (el) { el.click(); return true; }
          }
          return false;
        })()
      `) as boolean;
      if (!stopped) throw new Error('Stop control not found (agent may already be idle)');
      console.log('[command-executor] Stop generation clicked');
    });
  }

  /** Read the current composer text (works for textarea and contenteditable). */
  private async readComposerText(client: CdpClient): Promise<string> {
    const strategies = this.selectors.chatInput.strategies;
    const text = await client.evaluate(`
      (() => {
        const strategies = ${JSON.stringify(strategies)};
        let input = null;
        for (const sel of strategies) {
          try { input = document.querySelector(sel); if (input) break; } catch {}
        }
        if (!input) return '';
        const valueText = typeof input.value === 'string' ? input.value : '';
        const contentText = input.textContent ?? input.innerText ?? '';
        return (input.isContentEditable ? contentText : (valueText || contentText)).trim();
      })()
    `);
    return typeof text === 'string' ? text : '';
  }

  /**
   * Clear the composer (select all + Backspace) so `/` opens a fresh menu.
   * Without this, a stray "/" already sitting in the composer turns the
   * handler's own "/" into "//", which closes Cursor's slash tray instead of
   * opening it.
   */
  private async clearComposer(client: CdpClient): Promise<void> {
    const isMac = process.platform === 'darwin';
    await client.pressKey('Escape', 'Escape', 27);
    await sleep(60);
    await client.pressKey('a', 'KeyA', 65, isMac ? 4 : 2);
    await sleep(40);
    await client.pressKey('Backspace', 'Backspace', 8);
    await sleep(80);
  }

  private async focusComposer(client: CdpClient): Promise<void> {
    const strategies = this.selectors.chatInput.strategies;
    const focused = await client.evaluate(`
      (() => {
        const strategies = ${JSON.stringify(strategies)};
        let input = null;
        for (const sel of strategies) {
          try { input = document.querySelector(sel); if (input) break; } catch {}
        }
        if (!input) return false;
        input.scrollIntoView({ block: 'center', behavior: 'instant' });
        input.focus();
        input.click();
        return true;
      })()
    `) as boolean;
    if (!focused) throw new Error('Composer input not found');
  }

  async extractToolContent(toolCallId: string): Promise<{ code: string; language?: string; filename?: string } | null> {
    if (!this.client || !this.client.isConnected()) return null;

    const result = await this.client.evaluate(`
      (() => {
        const tcId = ${JSON.stringify(toolCallId)};
        const wrapperSel = ${JSON.stringify(MESSAGE_WRAPPER_SELECTOR)};
        const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
          || document.querySelector('[data-tool-call-id="' + tcId + '"]')?.closest(wrapperSel)
          || (() => {
            for (const el of document.querySelectorAll(wrapperSel)) {
              const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
              if (inner) return el;
            }
            return null;
          })();
        if (!wrapper) return null;

        const wasCollapsed = !!wrapper.querySelector('.composer-tool-former-message');
        if (wasCollapsed) {
          const header = wrapper.querySelector('.composer-tool-former-message') || wrapper.querySelector('.ui-collapsible-header');
          if (header) header.click();
        }

        function extract() {
          // Edit tool: look for code content in the diff viewer
          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();

            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          // Shell tool output
          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          // Generic expanded content
          const preEl = wrapper.querySelector('pre');
          if (preEl) {
            return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };
          }

          // Full text fallback
          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        }

        if (wasCollapsed) {
          return '__NEED_WAIT__';
        }
        return extract();
      })()
    `) as { code: string; language?: string; filename?: string } | '__NEED_WAIT__' | null;

    if (result === '__NEED_WAIT__') {
      await sleep(600);
      const expanded = await this.client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const wrapperSel = ${JSON.stringify(MESSAGE_WRAPPER_SELECTOR)};
          const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
            || (() => {
              for (const el of document.querySelectorAll(wrapperSel)) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return null;

          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();
            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          const preEl = wrapper.querySelector('pre');
          if (preEl) return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };

          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        })()
      `) as { code: string; language?: string; filename?: string } | null;

      // Collapse back
      await this.client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const wrapperSel = ${JSON.stringify(MESSAGE_WRAPPER_SELECTOR)};
          const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
            || (() => {
              for (const el of document.querySelectorAll(wrapperSel)) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return;
          const header = wrapper.querySelector('.ui-collapsible-header') || wrapper.querySelector('.composer-tool-former-message');
          if (header) header.click();
        })()
      `);

      return expanded;
    }

    return result;
  }

  async setModel(commandId: string, modelId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.modelDropdown?.strategies ?? [];

      // Step 1: Open the dropdown via JS .click() (same pattern as setMode).
      // Skip any trigger whose id starts with `plan-exec-model` (those belong
      // to the plan-execution picker, not the composer's model picker) — same
      // filter as openModelMenuAndReadOptions.
      const opened = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const candidates = document.querySelectorAll(sel);
              for (const c of Array.from(candidates)) {
                const cId = c.getAttribute('id') || '';
                if (cId.startsWith('plan-exec-model')) continue;
                c.click();
                return true;
              }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!opened) throw new Error('Model dropdown trigger not found');

      await sleep(300);

      // Step 2: Verify menu opened
      const menuVisible = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (!menuVisible) throw new Error('Model picker did not open');

      // Step 3: Find and click the model item via the shared helper so
      // setModel, setPlanModel, web client, and Telegram all resolve the
      // same way.
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(modelId)});
        })()
      `) as boolean;
      if (!selected) throw new Error(`Model "${modelId}" not found in dropdown`);

      await sleep(200);

      // Step 4: Verify dropdown closed (confirms selection was accepted)
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        console.warn(`[command-executor] Model dropdown still open — pressing Escape`);
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }

      console.log(`[command-executor] Model set to: ${modelId} (menu closed: ${!menuStillOpen})`);
    });
  }

  async getModelOptions(commandId: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openModelMenuAndReadOptions(client);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async getPlanModelOptions(commandId: string, selectorPath: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openPlanModelMenuAndReadOptions(client, selectorPath);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async setPlanModel(commandId: string, selectorPath: string, planModelId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await this.openPlanModelMenu(client, selectorPath);
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(planModelId)});
        })()
      `) as boolean;
      if (!selected) throw new Error(`Plan model "${planModelId}" not found`);

      await sleep(200);
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }
      console.log(`[command-executor] Plan model set to: ${planModelId}`);
    });
  }

  private async withRetry(
    commandId: string,
    action: (client: CdpClient) => Promise<void>
  ): Promise<CommandResult> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await action(this.client);
        return { commandId, ok: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async withRetryValue<T>(
    commandId: string,
    action: (client: CdpClient) => Promise<T>
  ): Promise<CommandResult & { data?: T }> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await action(this.client);
        return { commandId, ok: true, data };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async openPlanModelMenu(client: CdpClient, selectorPath: string): Promise<void> {
    const opened = await client.evaluate(`
      (() => {
        const selector = ${JSON.stringify(selectorPath)};
        const el = document.querySelector(selector);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return true;
      })()
    `) as boolean;
    if (!opened) throw new Error('Plan model dropdown trigger not found');

    await sleep(300);
    const menuVisible = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (!menuVisible) throw new Error('Plan model picker did not open');
  }

  private async openPlanModelMenuAndReadOptions(
    client: CdpClient,
    selectorPath: string
  ): Promise<{ options: PlanModelOption[] }> {
    await this.openPlanModelMenu(client, selectorPath);

    const options = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        ${MODEL_ITEM_HELPERS_JS}
        return collectModelItems(findModelMenu());
      })()
    `) as PlanModelOption[];

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return { options };
  }

  private async openModelMenuAndReadOptions(
    client: CdpClient
  ): Promise<{ options: PlanModelOption[] }> {
    const strategies = this.selectors.modelDropdown?.strategies ?? [];

    const opened = await client.evaluate(`
      (() => {
        const strategies = ${JSON.stringify(strategies)};
        for (const sel of strategies) {
          try {
            const candidates = document.querySelectorAll(sel);
            for (const c of Array.from(candidates)) {
              const cId = c.getAttribute('id') || '';
              if (!cId.startsWith('plan-exec-model')) {
                c.click();
                return true;
              }
            }
          } catch {}
        }
        return false;
      })()
    `) as boolean;
    if (!opened) throw new Error('Model dropdown trigger not found');

    await sleep(300);

    const menuVisible = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (!menuVisible) throw new Error('Model picker did not open');

    const options = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        ${MODEL_ITEM_HELPERS_JS}
        return collectModelItems(findModelMenu());
      })()
    `) as PlanModelOption[];

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return { options };
  }

  private async findFirstMatchingSelector(
    client: CdpClient,
    strategies: string[]
  ): Promise<string | null> {
    for (const selector of strategies) {
      try {
        if (await client.exists(selector)) return selector;
      } catch {
        // invalid selector, skip
      }
    }
    return null;
  }

  private async findApproveAllButton(client: CdpClient): Promise<string | null> {
    const found = await client.evaluate(`
      (() => {
        const keywords = ${JSON.stringify(this.selectors.approveButton.textMatch ?? [])};
        const strategies = ${JSON.stringify(this.selectors.approveButton.strategies)};
        const containerStrategies = ${JSON.stringify(this.selectors.chatContainer.strategies)};
        let root = null;
        for (const sel of containerStrategies) {
          try {
            root = document.querySelector(sel);
            if (root) break;
          } catch {}
        }
        if (!root) root = document.body;

        // Skip menu-trigger buttons (e.g. Cursor's "Auto-Run in Sandbox"
        // mode dropdown) — they open a settings menu, not an approval.
        const isMenuTrigger = (b) => {
          const p = b.getAttribute('aria-haspopup');
          return p === 'menu' || p === 'true' || p === 'listbox';
        };

        for (const selector of strategies) {
          try {
            const buttons = root.querySelectorAll(selector);
            for (const btn of Array.from(buttons)) {
              if (isMenuTrigger(btn)) continue;
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text.includes('all')) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return true;
              }
            }
          } catch {}
        }

        const allButtons = root.querySelectorAll('button');
        for (const btn of Array.from(allButtons)) {
          if (isMenuTrigger(btn)) continue;
          const text = (btn.textContent || '').trim().toLowerCase();
          for (const kw of keywords) {
            if (kw.toLowerCase().includes('all') && text.includes(kw.toLowerCase())) {
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return true;
            }
          }
        }

        return false;
      })()
    `) as boolean;

    if (!found) {
      throw new Error('"Accept All" button not found');
    }
    return '__clicked_inline__';
  }

  private async clickElementCenter(client: CdpClient, selector: string): Promise<void> {
    const rect = await client.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
      })()
    `) as { x: number; y: number; width: number; height: number } | null;

    if (!rect || rect.width === 0 || rect.height === 0) {
      throw new Error(`Element not clickable: ${selector}`);
    }

    await client.clickAtCoords(rect.x, rect.y);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
