import type { CdpClient } from './cdp-client.js';
import type {
  CodeBlockItem,
  CursorState,
  ChatElement,
  ChatTab,
  DiffLineKind,
  FolderAgent,
  ModeInfo,
  ModelInfo,
  SelectorConfig,
  WorkspaceFolder,
} from './types.js';
import { applyDerivedActivityToState } from './activity-derive.js';

const EVALUATE_TIMEOUT_MS = 5000;
const MAX_POLL_BACKOFF_MS = 5000;

export interface MessageWrapperSelection {
  element: Element;
  index: number;
}

// Keep this in sync with the inline copy inside extractionFunction. The inline
// copy is required because extractionFunction is serialized into Cursor's renderer.
export function selectMessageWrappers(container: ParentNode): MessageWrapperSelection[] {
  const dedupeNestedMatches = (elements: Element[]): Element[] => {
    const matched = new Set(elements);
    return elements.filter((element) => {
      let parent = element.parentElement;
      while (parent) {
        if (matched.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  };

  const wrappers = dedupeNestedMatches(
    Array.from(
      container.querySelectorAll(
        '[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role], [data-message-role][data-message-id]'
      )
    )
  );

  return wrappers.map((element, position) => {
    const rawIndex = element.getAttribute('data-flat-index') ?? element.getAttribute('data-message-index');
    const parsedIndex = rawIndex === null ? NaN : parseInt(rawIndex, 10);
    return {
      element,
      index: Number.isNaN(parsedIndex) ? position : parsedIndex,
    };
  });
}

/** Canonical tab title cleaning - matches extractionFunction's cleanTabTitle for consistent lookups. */
export function cleanTabTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  t = t.replace(/(@[\w./]+)+\s*$/, '');
  return t.trim().substring(0, 120);
}

/**
 * Runs inside Cursor's renderer process via Runtime.evaluate.
 * Must be completely self-contained (no Node.js imports).
 *
 * Uses Cursor's data attributes (data-flat-index, data-message-index,
 * data-message-role, data-message-kind, data-tool-status) for reliable extraction.
 */
export function extractionFunction(
  containerSelectors: string[],
  approveSelectors: string[],
  approveTextMatch: string[],
  rejectSelectors: string[],
  rejectTextMatch: string[],
  inputSelectors: string[],
  statusSelectors: string[],
  chatTabSelectors: string[],
  modeSelectors: string[],
  modelSelectors: string[],
  windowTitle?: string
): CursorState | null {
  function projectNameFromTitle(title: string): string {
    const idx = title.indexOf(' [');
    return (idx >= 0 ? title.substring(0, idx) : title).trim();
  }
  function findFirst(selectors: string[]): Element | null {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch { /* skip */ }
    }
    return null;
  }

  /**
   * Line diff stats from Edit tool UI. Tries legacy classes, then +N / -M chip spans
   * (Cursor sometimes omits or renames .ui-edit-tool-call__additions / __deletions).
   */
  function tryParseDiffStatsFromWrapper(scope: Element): { additions?: number; deletions?: number } {
    let additions: number | undefined;
    let deletions: number | undefined;
    const addEl = scope.querySelector('.ui-edit-tool-call__additions');
    const delEl = scope.querySelector('.ui-edit-tool-call__deletions');
    const addText = addEl?.textContent?.trim();
    const delText = delEl?.textContent?.trim();
    const addM = addText?.match(/\d+/);
    const delM = delText?.match(/\d+/);
    if (addM) additions = parseInt(addM[0], 10);
    if (delM) deletions = parseInt(delM[0], 10);
    if (additions !== undefined || deletions !== undefined) return { additions, deletions };

    for (const el of Array.from(scope.querySelectorAll('span, div, a'))) {
      const t = (el.textContent || '').trim();
      if (additions === undefined && /^\+\d+$/.test(t)) additions = parseInt(t.slice(1), 10);
      if (deletions === undefined && /^-\d+$/.test(t)) deletions = parseInt(t.slice(1), 10);
      if (additions !== undefined && deletions !== undefined) break;
    }
    return { additions, deletions };
  }

  function buildSelectorPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) {
        seg += `#${cur.id.replace(/([.:])/g, '\\$1')}`;
        parts.unshift(seg);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === cur!.tagName);
        if (siblings.length > 1) {
          seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }

  try {
    const container = findFirst(containerSelectors);
    if (!container) return null;

    // Keep this in sync with selectMessageWrappers above. This copy must stay
    // self-contained because extractionFunction is serialized into Cursor's renderer.
    function dedupeNestedMessageMatches(elements: Element[]): Element[] {
      const matched = new Set(elements);
      return elements.filter((element) => {
        let parent = element.parentElement;
        while (parent) {
          if (matched.has(parent)) return false;
          parent = parent.parentElement;
        }
        return true;
      });
    }

    const messageWrappers = dedupeNestedMessageMatches(
      Array.from(
        container.querySelectorAll(
          '[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role], [data-message-role][data-message-id]'
        )
      )
    );

    let containerComposerId =
      container.getAttribute('data-composer-id') ||
      container.closest('[data-composer-id]')?.getAttribute('data-composer-id') ||
      '';
    if (!containerComposerId && messageWrappers.length > 0) {
      const firstMsg = messageWrappers[0];
      containerComposerId = firstMsg.closest('[data-composer-id]')?.getAttribute('data-composer-id') || '';
    }

    const elements: ChatElement[] = [];
    const _rawElements: Array<{
      flatIndex: number; role?: string; kind?: string; messageId?: string;
      toolCallId?: string; toolStatus?: string; indicators: string[];
      textPreview: string; parsedAs: string;
    }> = [];

    function detectIndicators(el: Element): string[] {
      const flags: string[] = [];
      if (el.querySelector('.loading-indicator-v3')) flags.push('loading-v3');
      if (el.querySelector('.make-shine')) flags.push('make-shine');
      if (el.querySelector('.ui-collapsible.ui-step-group-collapsible')) flags.push('step-group');
      if (el.querySelector('.composer-tool-former-message')) flags.push('compact-tool');
      if (el.querySelector('.composer-terminal-tool-call-block-container') ||
          el.querySelector('.composer-tool-call-container.composer-terminal-compact-mode')) flags.push('run-command');
      if (el.querySelector('.plan-execution-message-content')) flags.push('plan-execution');
      if (el.querySelector('.composer-create-plan-container')) flags.push('plan-create');
      if (el.querySelector('.composer-edit-file-review-wrapper')) flags.push('edit-review');
      if (el.querySelector('.todo-list-container')) flags.push('todo-list');
      if (el.querySelector('.ui-tool-call-line-action')) flags.push('tool-line');
      if (el.querySelector('.ui-edit-tool-call__filename')) flags.push('edit-file');
      if (el.querySelector('.composer-message-group')) flags.push('message-group');
      if (el.querySelector('.markdown-root')) flags.push('markdown');
      if (el.querySelector('.aislash-editor-input-readonly')) flags.push('human-input');
      return flags;
    }

    function durationFromThoughtText(raw: string): string {
      const t = raw.trim();
      const forM = t.match(/\bfor\s+([\d.]+\s*s(?:ec(?:onds?)?)?)\b/i);
      if (forM) return forM[1].replace(/\s+/g, '');
      const bareM = t.match(/^([\d.]+\s*s(?:ec(?:onds?)?)?)$/i);
      if (bareM) return bareM[1].replace(/\s+/g, '');
      return '';
    }

    function isDurationOnlyThoughtSpan(raw: string): boolean {
      const t = raw.trim();
      if (/^for\s+/i.test(t)) return false;
      return !!durationFromThoughtText(t) && t.length <= 20;
    }

    /** Header shows a finished timing (for 2s, or trailing 9s). */
    function collapsibleHeaderTextLooksComplete(ht: string): boolean {
      const t = ht.replace(/\s+/g, ' ').trim();
      if (!t) return false;
      if (/\bfor\s+[\d.]+\s*s(ec(onds?)?)?\b/i.test(t)) return true;
      if (/\b[\d.]+\s*s(ec(onds?)?)?\s*$/i.test(t)) return true;
      return false;
    }

    function parseThoughtSpansFromHeader(headerEl: Element | null): {
      action: string;
      detail: string;
      duration: string;
    } {
      if (!headerEl) return { action: '', detail: '', duration: '' };
      const headerSpans = headerEl.querySelectorAll(':scope > span');
      let action = '';
      let detail = '';
      let duration = '';
      for (const s of Array.from(headerSpans)) {
        if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
        const t = (s.textContent || '').trim();
        if (!t) continue;
        const d = durationFromThoughtText(t);
        if (d && !duration) duration = d;
        if (isDurationOnlyThoughtSpan(t)) continue;
        if (!action) {
          action = t;
          continue;
        }
        if (t.startsWith('for ')) {
          duration = duration || t.replace(/^for\s+/i, '').trim();
          detail = t;
        } else {
          detail = detail || t;
        }
      }
      if (!duration) {
        const fullHeader = (headerEl.textContent || '').replace(/\s+/g, ' ').trim();
        duration = durationFromThoughtText(fullHeader);
      }
      return { action, detail, duration };
    }

    type RawElRef = {
      flatIndex: number;
      role?: string;
      kind?: string;
      messageId?: string;
      toolCallId?: string;
      toolStatus?: string;
      indicators: string[];
      textPreview: string;
      parsedAs: string;
    };

    function cleanCodeLine(raw: string): string {
      return (raw || '').replace(/\u00a0/g, ' ').replace(/\r/g, '').trimEnd();
    }

    function trimOuterBlankCodeLines(lines: string[]): string[] {
      const out = [...lines];
      while (out.length > 0 && out[0].trim().length === 0) out.shift();
      while (out.length > 0 && out[out.length - 1].trim().length === 0) out.pop();
      return out;
    }

    function joinCodeLines(lines: string[]): string {
      return trimOuterBlankCodeLines(lines.map(cleanCodeLine)).join('\n');
    }

    function extractStructuredCodeText(root: Element): string {
      const parts: string[] = [];

      function ensureNewline(): void {
        if (parts.length === 0) return;
        const last = parts[parts.length - 1] || '';
        if (!last.endsWith('\n')) parts.push('\n');
      }

      function hasBlockishChildren(el: Element): boolean {
        return Array.from(el.children).some((child) => {
          const tag = (child.tagName || '').toLowerCase();
          return (
            tag === 'div' ||
            tag === 'p' ||
            tag === 'li' ||
            child.matches('.ui-default-code__line-content, .view-line, [data-line], .line')
          );
        });
      }

      function walk(node: Node): void {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = cleanCodeLine(node.textContent || '');
          if (text) parts.push(text);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'br') {
          ensureNewline();
          return;
        }

        const lineLike =
          el.matches('.ui-default-code__line-content, .view-line, [data-line], .line') ||
          ((tag === 'div' || tag === 'p' || tag === 'li') && !hasBlockishChildren(el));

        const beforeCount = parts.length;
        el.childNodes.forEach(walk);
        if (lineLike && parts.length > beforeCount) ensureNewline();
      }

      walk(root);
      return joinCodeLines(parts.join('').split('\n'));
    }

    function extractComposerPlainText(cb: Element): string {
      const codeContent = cb.querySelector('.ui-default-code__content');
      const contentRoot =
        codeContent ||
        cb.querySelector('.composer-code-block-content, .ui-code-block-content') ||
        cb;
      let code = '';
      if (codeContent) {
        const lineEls = codeContent.querySelectorAll('.ui-default-code__line-content');
        code =
          lineEls.length > 0
            ? joinCodeLines(
                Array.from(lineEls).map((l) => l.textContent || '')
              )
            : extractStructuredCodeText(codeContent);
      }
      if (!code) {
        const vl = cb.querySelectorAll('.view-line');
        if (vl.length > 0) {
          code = joinCodeLines(
            Array.from(vl)
              .map((line) => line.textContent || '')
              .filter((ln) => ln.trim().length > 0)
          );
        }
      }
      if (!code) {
        const diffEl = cb.querySelector('.composer-diff-block');
        if (diffEl) {
          const vl2 = diffEl.querySelectorAll('.view-line');
          code = joinCodeLines(Array.from(vl2).map((line) => line.textContent || ''));
        }
      }
      if (!code && contentRoot) code = extractStructuredCodeText(contentRoot);
      return code;
    }

    function parseTopPx(style: string | null | undefined): number | undefined {
      const m = (style || '').match(/top:\s*([\d.]+)px/);
      return m ? parseFloat(m[1]) : undefined;
    }

    function parseHeightPx(style: string | null | undefined): number | undefined {
      const m = (style || '').match(/height:\s*([\d.]+)px/);
      return m ? parseFloat(m[1]) : undefined;
    }

    function lineKindFromOverlays(editorRoot: Element, lineTop: number): 'add' | 'rem' | null {
      const overlayRows = editorRoot.querySelectorAll('.view-overlays > div');
      for (let i = 0; i < overlayRows.length; i++) {
        const row = overlayRows[i];
        const t = parseTopPx(row.getAttribute('style'));
        if (t === undefined || Math.abs(t - lineTop) > 2) continue;
        if (row.querySelector('.cdr.line-insert, .cdr.char-insert')) return 'add';
        if (row.querySelector('.cdr.line-delete, .cdr.char-delete')) return 'rem';
      }
      return null;
    }

    function lineRemFromViewZones(editorRoot: Element, lineTop: number, lineHeight: number): boolean {
      const zones = editorRoot.querySelectorAll('.view-zones > div');
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        if (!z.classList.contains('diagonal-fill')) continue;
        const t = parseTopPx(z.getAttribute('style'));
        const h = parseHeightPx(z.getAttribute('style')) || 16;
        if (t === undefined) continue;
        if (lineTop + lineHeight > t && lineTop < t + h) return true;
      }
      return false;
    }

    function extractViewLinesWithKinds(
      editorRoot: Element,
      side: 'original' | 'modified'
    ): { kind: DiffLineKind; text: string }[] {
      const lines = editorRoot.querySelectorAll('.view-lines > .view-line');
      const out: { kind: DiffLineKind; text: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const text = (line.textContent || '').replace(/\u00a0/g, ' ').replace(/\r/g, '').trimEnd();
        const lineTop = parseTopPx(line.getAttribute('style'));
        const ht = parseHeightPx(line.getAttribute('style')) || 16;
        let kind: DiffLineKind = 'ctx';
        const topPx = lineTop ?? 0;
        if (side === 'original') {
          const o = lineKindFromOverlays(editorRoot, topPx);
          if (o === 'rem') kind = 'rem';
          else if (lineRemFromViewZones(editorRoot, topPx, ht)) kind = 'rem';
        } else if (lineKindFromOverlays(editorRoot, topPx) === 'add') {
          kind = 'add';
        }
        out.push({ kind, text });
      }
      return out;
    }

    function parseUnifiedDiffLines(code: string): { kind: DiffLineKind; text: string }[] | undefined {
      const lines = (code || '').replace(/\r/g, '').split('\n');
      if (lines.length === 0) return undefined;

      let addCount = 0;
      let remCount = 0;
      let signalCount = 0;
      const diffLines: { kind: DiffLineKind; text: string }[] = [];

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        let kind: DiffLineKind = 'ctx';

        if (
          line.startsWith('*** Begin Patch') ||
          line.startsWith('*** Update File:') ||
          line.startsWith('*** Add File:') ||
          line.startsWith('*** Delete File:') ||
          line.startsWith('*** End Patch') ||
          line.startsWith('*** End of File') ||
          line.startsWith('diff --') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ')
        ) {
          kind = 'meta';
          signalCount++;
        } else if (line.startsWith('@@')) {
          kind = 'hunk';
          signalCount++;
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          kind = 'add';
          addCount++;
          signalCount++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          kind = 'rem';
          remCount++;
          signalCount++;
        }

        diffLines.push({ kind, text: line });
      }

      const looksDiff =
        (addCount > 0 || remCount > 0) &&
        (signalCount >= 2 || lines.some((line) => line.startsWith('@@') || line.startsWith('*** ')));

      return looksDiff ? diffLines : undefined;
    }

    function extractCodeBlockItem(cb: Element): CodeBlockItem {
      const headerEl = cb.querySelector('.ui-code-block-header');
      const filenameEl = cb.querySelector('.composer-code-block-filename, .ui-code-block-filename');
      const filename = filenameEl ? (filenameEl.textContent || '').trim() || undefined : undefined;
      const language = headerEl ? headerEl.getAttribute('data-language') || undefined : undefined;

      const diffEditor = cb.querySelector('.monaco-diff-editor');
      if (diffEditor) {
        const orig = diffEditor.querySelector('.editor.original');
        const mod = diffEditor.querySelector('.editor.modified');
        const diffLines: { kind: DiffLineKind; text: string }[] = [];
        if (orig) diffLines.push(...extractViewLinesWithKinds(orig, 'original'));
        if (mod) diffLines.push(...extractViewLinesWithKinds(mod, 'modified'));
        const code = diffLines.map(function (d) {
          return d.text;
        }).join('\n');
        return { blockKind: 'diff', filename, language, code, diffLines };
      }

      const code = extractComposerPlainText(cb);
      const parsedDiffLines = parseUnifiedDiffLines(code);
      if (parsedDiffLines) {
        return { blockKind: 'diff', filename, language, code, diffLines: parsedDiffLines };
      }
      return { blockKind: 'code', filename, language, code };
    }

    function extractDiffBlockFromScope(scope: Element): CodeBlockItem | undefined {
      const block = scope.querySelector('.composer-code-block-container, .composer-message-codeblock');
      if (!block) return undefined;
      return extractCodeBlockItem(block);
    }

    function extractToolActions(
      container: Element
    ): { label: string; type: 'run' | 'skip' | 'allow'; selectorPath: string }[] {
      const actions: { label: string; type: 'run' | 'skip' | 'allow'; selectorPath: string }[] = [];
      const seenPaths = new Set<string>();

      const skipBtn = container.querySelector('.composer-skip-button');
      if (skipBtn) {
        const path = buildSelectorPath(skipBtn);
        seenPaths.add(path);
        actions.push({ label: 'Skip', type: 'skip' as const, selectorPath: path });
      }

      const runBtns = container.querySelectorAll('.composer-run-button, .anysphere-secondary-button');
      for (const btn of Array.from(runBtns)) {
        const path = buildSelectorPath(btn);
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        const btnText = (btn.textContent || '').replace(/[⏎⌘⇧]/g, '').trim();
        const isAllow =
          btn.classList.contains('anysphere-secondary-button') || btnText.toLowerCase().includes('allow');
        if (isAllow) {
          actions.push({ label: btnText, type: 'allow' as const, selectorPath: path });
        } else {
          actions.push({ label: btnText || 'Run', type: 'run' as const, selectorPath: path });
        }
      }

      return actions;
    }

    function extractAiTool(
      toolRoot: Element,
      flatIndex: number,
      messageId: string,
      patchRaw: RawElRef | null
    ): { element: ChatElement; parsedAs: string } | null {
      const toolEl = toolRoot.querySelector('[data-tool-call-id]') || toolRoot;
      const toolCallId = toolEl.getAttribute('data-tool-call-id') || `tool-${flatIndex}`;
      const toolStatus = (toolEl.getAttribute('data-tool-status') ||
        toolRoot.getAttribute('data-tool-status') ||
        'completed') as 'loading' | 'completed';
      if (patchRaw) {
        patchRaw.toolCallId = toolCallId;
        patchRaw.toolStatus = toolStatus;
      }

      const planContainer = toolRoot.querySelector('.composer-create-plan-container');
      if (planContainer) {
        const label = (planContainer.querySelector('.composer-create-plan-label')?.textContent || '').trim();
        const title = (planContainer.querySelector('.composer-create-plan-title')?.textContent || '').trim();
        const descRoot = planContainer.querySelector('.composer-create-plan-text .markdown-root');
        const description = descRoot ? (descRoot.textContent || '').trim() : undefined;
        const descriptionHtml = descRoot ? (descRoot.innerHTML || '').trim() : undefined;

        const todoItems = planContainer.querySelectorAll('.composer-create-plan-todo-item');
        const todos: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
        let todosCompleted = 0;
        let todosTotal = 0;
        let todosMoreCount: number | undefined;
        for (const item of Array.from(todoItems)) {
          if (item.querySelector('.composer-plan-todo-ellipsis')) {
            const moreEl = item.querySelector('.composer-plan-todo-more-text');
            const moreText = (moreEl?.textContent || '').trim();
            const moreMatch = moreText.match(/(\d+)\s+more/i);
            if (moreMatch) todosMoreCount = parseInt(moreMatch[1], 10);
            continue;
          }
          const contentEl = item.querySelector('.composer-create-plan-todo-content');
          if (!contentEl) continue;
          const text = (contentEl.textContent || '').trim();
          if (!text) continue;
          const indicator = item.querySelector('.composer-plan-todo-indicator');
          let status: 'pending' | 'completed' | 'in_progress' = 'pending';
          if (indicator) {
            const cls = indicator.className || '';
            if (cls.includes('completed')) {
              status = 'completed';
              todosCompleted++;
            } else if (cls.includes('in_progress') || cls.includes('in-progress')) status = 'in_progress';
          }
          todosTotal++;
          todos.push({ text, status });
        }

        const todosHeader = (planContainer.querySelector('.composer-create-plan-todos-header')?.textContent || '').trim();
        const headerMatch = todosHeader.match(/(\d+)/);
        if (headerMatch && todosTotal === 0) {
          todosTotal = parseInt(headerMatch[0], 10);
        }

        const actions: { label: string; type: 'view_plan' | 'build'; selectorPath: string }[] = [];
        const viewPlanBtn = planContainer.querySelector('.composer-create-plan-view-plan-button');
        if (viewPlanBtn) {
          actions.push({
            label: 'View Plan',
            type: 'view_plan' as const,
            selectorPath: buildSelectorPath(viewPlanBtn),
          });
        }
        let buildBtn: Element | null = null;
        const buildCandidates = planContainer.querySelectorAll('.composer-create-plan-build-button');
        for (const b of Array.from(buildCandidates)) {
          const tx = (b.textContent || '').replace(/\s+/g, ' ').trim();
          if (/build/i.test(tx) && tx.length > 2) {
            buildBtn = b;
            break;
          }
        }
        if (!buildBtn && buildCandidates.length > 0) buildBtn = buildCandidates[0];
        if (buildBtn) {
          actions.push({ label: 'Build', type: 'build' as const, selectorPath: buildSelectorPath(buildBtn) });
        }

        const modelEl = planContainer.querySelector('.composer-unified-dropdown-model');
        let model: string | undefined;
        let modelDropdownSelectorPath: string | undefined;
        if (modelEl) {
          modelDropdownSelectorPath = buildSelectorPath(modelEl);
          const spans = modelEl.querySelectorAll('span');
          for (const s of Array.from(spans)) {
            const t = (s.textContent || '').trim();
            if (t && !t.includes('chevron') && t.length > 1) {
              model = t;
              break;
            }
          }
        }

        return {
          element: {
            type: 'plan' as const,
            id: messageId,
            flatIndex,
            label,
            title,
            description,
            descriptionHtml: descriptionHtml || undefined,
            todosCompleted,
            todosTotal,
            todos: todos.length > 0 ? todos : undefined,
            todosMoreCount,
            model,
            modelDropdownSelectorPath,
            actions: actions.length > 0 ? actions : undefined,
          },
          parsedAs: 'plan',
        };
      }

      const runContainer =
        toolRoot.querySelector('.composer-terminal-tool-call-block-container') ||
        toolRoot.querySelector('.composer-tool-call-container.composer-terminal-compact-mode');
      if (runContainer) {
        const descEl = runContainer.querySelector('.composer-terminal-top-header-description');
        const candidatesEl = runContainer.querySelector('.composer-terminal-top-header-candidates');
        const commandEl =
          runContainer.querySelector('.composer-terminal-command-expanded-text') ||
          runContainer.querySelector('.composer-terminal-command-editor') ||
          runContainer.querySelector('.composer-terminal-command-wrapper') ||
          runContainer.querySelector('.composer-tool-call-header-content');
        const description = (descEl?.textContent || '').trim();
        const candidates = (candidatesEl?.textContent || '').trim();

        let command = '';
        if (commandEl) {
          const rawCmd = (commandEl.textContent || '').replace(/^\$\s*/, '');
          const cmdLines = rawCmd.split('\n');
          const nonEmpty = cmdLines.filter(function (l: string) {
            return l.trim().length > 0;
          });
          let minIndent = 0;
          if (nonEmpty.length > 0) {
            minIndent = Infinity;
            for (let li = 0; li < nonEmpty.length; li++) {
              const m = nonEmpty[li].match(/^(\s*)/);
              const len = m ? m[1].length : 0;
              if (len < minIndent) minIndent = len;
            }
          }
          command = cmdLines
            .map(function (l: string) {
              return l.length >= minIndent ? l.substring(minIndent) : l;
            })
            .join('\n')
            .trim();
        }

        const runActions = extractToolActions(runContainer);

        return {
          element: {
            type: 'run_command' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            description,
            candidates,
            command,
            actions: runActions,
          },
          parsedAs: 'run_command',
        };
      }

      const editReviewEl = toolRoot.querySelector('.composer-edit-file-review-wrapper');
      if (editReviewEl) {
        const filenameEl = editReviewEl.querySelector('.composer-code-block-filename');
        const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;

        const statusSpans = editReviewEl.querySelectorAll('.composer-code-block-status span');
        let additions: number | undefined;
        let deletions: number | undefined;
        for (const s of Array.from(statusSpans)) {
          const t = (s.textContent || '').trim();
          const addM = t.match(/^\+(\d+)$/);
          const delM = t.match(/^-(\d+)$/);
          if (addM) additions = parseInt(addM[1], 10);
          if (delM) deletions = parseInt(delM[1], 10);
        }
        const editDiffFb = tryParseDiffStatsFromWrapper(editReviewEl);
        if (additions === undefined) additions = editDiffFb.additions;
        if (deletions === undefined) deletions = editDiffFb.deletions;

        const blockedPill = editReviewEl.querySelector('.block-attribution-pill');
        const blocked = blockedPill
          ? (blockedPill.getAttribute('aria-label') || blockedPill.textContent || '').trim()
          : undefined;

        const statusRow = editReviewEl.querySelector('.composer-tool-call-status-row');
        const editActions = statusRow
          ? extractToolActions(statusRow)
          : extractToolActions(editReviewEl);

        const diffBlock = extractDiffBlockFromScope(editReviewEl);
        return {
          element: {
            type: 'tool' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            status: toolStatus,
            action: 'Edit',
            details: '',
            filename,
            additions,
            deletions,
            blocked: blocked || undefined,
            actions: editActions.length > 0 ? editActions : undefined,
            ...(diffBlock ? { diffBlock } : {}),
          },
          parsedAs: 'tool:edit-review',
        };
      }

      const todoListContainer = toolRoot.querySelector('.todo-list-container');
      if (todoListContainer) {
        const headerElTodo = todoListContainer.querySelector('.todo-list-header-left-title');
        const title = (headerElTodo?.textContent || 'To-dos').replace(/\d+\s*$/, '').trim();
        const todoItems2 = todoListContainer.querySelectorAll('.ui-todo-item');
        const todos2: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
        let todosCompleted2 = 0;
        for (const item of Array.from(todoItems2)) {
          const contentEl2 = item.querySelector('.ui-todo-item__content');
          const text = (contentEl2?.textContent || '').trim();
          if (!text) continue;
          const cls = item.className || '';
          let status: 'pending' | 'completed' | 'in_progress' = 'pending';
          if (cls.includes('completed')) {
            status = 'completed';
            todosCompleted2++;
          } else if (cls.includes('dimmed') || (contentEl2 && contentEl2.className.includes('in-progress'))) {
            status = 'in_progress';
          }
          todos2.push({ text, status });
        }
        return {
          element: {
            type: 'todo_list' as const,
            id: messageId,
            flatIndex,
            title,
            todosCompleted: todosCompleted2,
            todosTotal: todos2.length,
            todos: todos2,
          },
          parsedAs: 'todo_list',
        };
      }

      const compactEl = toolRoot.querySelector('.composer-tool-former-message');
      if (compactEl) {
        let actionPart = '';
        let descPart = '';

        const headerContent = compactEl.querySelector('.composer-tool-call-header-content');
        if (headerContent) {
          const headerSpans = headerContent.querySelectorAll('span');
          for (const s of Array.from(headerSpans)) {
            const txt = (s.textContent || '').trim();
            if (!txt) continue;
            if (s.classList.toString().includes('codicon') || s.classList.toString().includes('cursor-icon')) continue;
            if (!actionPart) {
              actionPart = txt;
            } else if (!descPart) {
              descPart = txt;
            }
          }
        } else {
          const spans = compactEl.querySelectorAll('span');
          for (const s of Array.from(spans)) {
            if (s.closest('.composer-tool-call-control-row') || s.closest('.composer-tool-call-status-row')) continue;
            const txt = (s.textContent || '').trim();
            if (!txt) continue;
            if (s.classList.toString().includes('codicon') || s.classList.toString().includes('cursor-icon')) continue;
            if (s.classList.contains('truncate-one-line') || s.classList.toString().includes('truncate')) {
              descPart = txt;
            } else if (!actionPart) {
              actionPart = txt;
            }
          }
        }

        const compactActions = extractToolActions(compactEl);
        const summaryText = headerContent
          ? ''
          : (compactEl.textContent || '').trim();
        const compactDiff = tryParseDiffStatsFromWrapper(toolRoot);
        const diffBlockCompact = extractDiffBlockFromScope(toolRoot);
        return {
          element: {
            type: 'tool' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            status: toolStatus,
            action: actionPart || '',
            details: descPart || '',
            summaryText: !actionPart && !descPart && summaryText ? summaryText : undefined,
            additions: compactDiff.additions,
            deletions: compactDiff.deletions,
            actions: compactActions.length > 0 ? compactActions : undefined,
            ...(diffBlockCompact ? { diffBlock: diffBlockCompact } : {}),
          },
          parsedAs: 'tool:compact',
        };
      }

      const actionEl = toolRoot.querySelector('.ui-tool-call-line-action');
      const detailsEl = toolRoot.querySelector('.ui-tool-call-line-details');
      let action = (actionEl?.textContent || '').trim();
      let details = (detailsEl?.textContent || '').trim();

      const filenameEl2 = toolRoot.querySelector('.ui-edit-tool-call__filename');
      const additionsEl = toolRoot.querySelector('.ui-edit-tool-call__additions');
      const deletionsEl = toolRoot.querySelector('.ui-edit-tool-call__deletions');
      const filename2 = filenameEl2 ? (filenameEl2.textContent || '').trim() : undefined;
      const addMatch = additionsEl ? (additionsEl.textContent || '').match(/\d+/) : null;
      const delMatch = deletionsEl ? (deletionsEl.textContent || '').match(/\d+/) : null;
      let additions2 = addMatch ? parseInt(addMatch[0], 10) : undefined;
      let deletions2 = delMatch ? parseInt(delMatch[0], 10) : undefined;
      const lineDiffFb = tryParseDiffStatsFromWrapper(toolRoot);
      if (additions2 === undefined) additions2 = lineDiffFb.additions;
      if (deletions2 === undefined) deletions2 = lineDiffFb.deletions;

      const shellCmd = toolRoot.querySelector('.ui-shell-tool-call__command');
      if (shellCmd && !details) details = (shellCmd.textContent || '').trim();

      if (!action) {
        const cardHeader = toolRoot.querySelector('.ui-tool-call-card__header');
        if (cardHeader) action = (cardHeader.textContent || '').trim().split('\n')[0].trim();
      }

      if (!action) {
        const fullText = (toolRoot.textContent || '').trim();
        if (fullText.length > 0 && fullText.length < 200) {
          action = fullText.substring(0, 60);
        }
      }

      const diffBlockLine = extractDiffBlockFromScope(toolRoot);
      const fallbackActions = extractToolActions(toolRoot);
      return {
        element: {
          type: 'tool' as const,
          id: messageId,
          flatIndex,
          toolCallId,
          status: toolStatus,
          action: action || 'Tool',
          details,
          filename: filename2 || (action === 'Edit' || action === 'Write' ? details : undefined),
          additions: additions2,
          deletions: deletions2,
          actions: fallbackActions.length > 0 ? fallbackActions : undefined,
          ...(diffBlockLine ? { diffBlock: diffBlockLine } : {}),
        },
        parsedAs: !action && !details && !filename2 ? 'tool:fallback' : 'tool',
      };
    }

    for (const [wrapperPosition, wrapper] of messageWrappers.entries()) {
      const rawFlatIndex = wrapper.getAttribute('data-flat-index') ?? wrapper.getAttribute('data-message-index');
      const parsedFlatIndex = rawFlatIndex === null ? NaN : parseInt(rawFlatIndex, 10);
      const flatIndex = Number.isNaN(parsedFlatIndex) ? wrapperPosition : parsedFlatIndex;

      const msgEl = wrapper.querySelector('[data-message-role]') || wrapper;
      let role = msgEl.getAttribute('data-message-role');
      const rowKind = msgEl.getAttribute('data-react-transcript-row-kind');
      let kind = msgEl.getAttribute('data-message-kind');
      if (!kind && rowKind === 'assistantMarkdown') {
        kind = 'assistant';
      }
      if (!kind && rowKind === 'activity') {
        const rowKey = msgEl.closest('[data-find-row-key]')?.getAttribute('data-find-row-key') || '';
        if (rowKey.startsWith('tool-placeholder:')) {
          kind = 'tool';
          if (!role) role = 'ai';
        } else if (rowKey.startsWith('activity-group:') && rowKey.includes(':thinking')) {
          // Thinking has no message-level kind; thoughts are modeled as element type "thought".
          kind = null;
        }
      }
      // Observed but intentionally unmapped row-kind values: workGroup, turnActions,
      // activityGroup, tailStatus, and activity rows that are not tool placeholders.
      const messageId = msgEl.getAttribute('data-message-id') || `fi-${flatIndex}`;

      const rawEl = {
        flatIndex,
        role: role || undefined,
        kind: kind || undefined,
        messageId,
        toolCallId: undefined as string | undefined,
        toolStatus: undefined as string | undefined,
        indicators: detectIndicators(wrapper),
        textPreview: (wrapper.textContent || '').trim().substring(0, 120),
        parsedAs: 'unknown',
      };
      _rawElements.push(rawEl);

      // --- Loading indicator (skip as content — handled as agentActivity) ---
      if (wrapper.querySelector('.loading-indicator-v3')) {
        rawEl.parsedAs = 'skipped:loading';
        continue;
      }

      // --- Composer message group: Explored + nested ui-thinking-collapsible + tools (one flat-index) ---
      const composerGroup = wrapper.querySelector('.composer-message-group');
      const stepGroupCollapsible = wrapper.querySelector('.ui-collapsible.ui-step-group-collapsible');
      if (composerGroup && stepGroupCollapsible) {
        rawEl.parsedAs = 'message-group';
        const outerHeader = stepGroupCollapsible.querySelector(':scope > .ui-collapsible-header');
        const outerParsed = parseThoughtSpansFromHeader(outerHeader);
        if (outerParsed.action || outerParsed.detail || outerParsed.duration) {
          elements.push({
            type: 'thought' as const,
            id: `thought-${flatIndex}-summary`,
            flatIndex,
            duration: outerParsed.duration,
            action: outerParsed.action || undefined,
            detail: outerParsed.detail || undefined,
            thoughtKind: 'step_summary' as const,
          });
        }
        const contentEl = stepGroupCollapsible.querySelector(':scope > .ui-collapsible-content');
        const column = contentEl?.firstElementChild;
        if (column) {
          let seq = 0;
          for (const child of Array.from(column.children)) {
            if (child.classList.contains('ui-thinking-collapsible')) {
              const h = child.querySelector(':scope > .ui-collapsible-header');
              const p = parseThoughtSpansFromHeader(h);
              if (p.action || p.detail || p.duration) {
                elements.push({
                  type: 'thought' as const,
                  id: `thought-${flatIndex}-s${seq}`,
                  flatIndex,
                  duration: p.duration,
                  action: p.action || undefined,
                  detail: p.detail || undefined,
                  thoughtKind: 'thinking_step' as const,
                });
              }
              seq++;
              continue;
            }
            const toolHost =
              child.getAttribute('data-message-role') === 'ai' && child.getAttribute('data-message-kind') === 'tool'
                ? child
                : child.querySelector(':scope > [data-message-role="ai"][data-message-kind="tool"]');
            if (toolHost) {
              const mid =
                toolHost.getAttribute('data-message-id') || `fi-${flatIndex}-g${seq}`;
              const parsedTool = extractAiTool(toolHost as Element, flatIndex, mid, null);
              if (parsedTool) {
                elements.push(parsedTool.element);
                seq++;
              }
            }
          }
        }
        continue;
      }

      // --- Step-group header (Thought, Explored, Searched, Read, etc.) — lone wrapper, no message-role ---
      const thoughtEl = wrapper.querySelector('.ui-collapsible.ui-step-group-collapsible');
      if (thoughtEl && !role) {
        const hdr = thoughtEl.querySelector('.ui-collapsible-header');
        const parsed = parseThoughtSpansFromHeader(hdr);
        elements.push({
          type: 'thought' as const,
          id: `thought-${flatIndex}`,
          flatIndex,
          duration: parsed.duration,
          action: parsed.action || undefined,
          detail: parsed.detail || undefined,
        });
        rawEl.parsedAs = 'thought';
        continue;
      }

      // --- Human message ---
      if (role === 'human' && kind === 'human') {
        // Check for plan block
        const planContent = wrapper.querySelector('.plan-execution-message-content');
        if (planContent) {
          const label = (planContent.querySelector('.plan-execution-label')?.textContent || '').trim();
          const title = (planContent.querySelector('.plan-execution-title')?.textContent || '').trim();
          const todoSummary = wrapper.querySelector('.todo-summary-content');
          let todosCompleted = 0;
          let todosTotal = 0;
          if (todoSummary) {
            const summaryText = todoSummary.textContent || '';
            const ofMatch = summaryText.match(/(\d+)\s+of\s+(\d+)/);
            const slashMatch = summaryText.match(/(\d+)\s*\/\s*(\d+)/);
            const countMatch = ofMatch || slashMatch;
            if (countMatch) {
              todosCompleted = parseInt(countMatch[1], 10);
              todosTotal = parseInt(countMatch[2], 10);
            }
          }

          const todos: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
          const summaryItems = wrapper.querySelectorAll('.todo-summary-item');
          for (const item of Array.from(summaryItems)) {
            const contentEl = item.querySelector('.todo-summary-item-content');
            const text = (contentEl?.textContent || '').trim();
            if (!text) continue;
            const contentCls = contentEl?.className || '';
            let status: 'pending' | 'completed' | 'in_progress' = 'pending';
            if (contentCls.includes('todo-completed')) { status = 'completed'; }
            else if (contentCls.includes('todo-in-progress') || item.querySelector('.todo-summary-in-progress-circle')) { status = 'in_progress'; }
            todos.push({ text, status });
          }

          // Collapsed: items not rendered yet. Click to expand; they'll appear next poll cycle.
          if (todos.length === 0 && todosTotal > 0) {
            const clickable = wrapper.querySelector('.todo-summary-content-clickable') as HTMLElement | null;
            if (clickable) clickable.click();
          }

          if (todos.length > 0 && todosTotal === 0) {
            todosTotal = todos.length;
            todosCompleted = todos.filter(function(t) { return t.status === 'completed'; }).length;
          }

          elements.push({
            type: 'plan' as const,
            id: messageId,
            flatIndex,
            label,
            title,
            todosCompleted,
            todosTotal,
            todos: todos.length > 0 ? todos : undefined,
          });
          rawEl.parsedAs = 'plan';
          continue;
        }

        // Regular human message
        const inputEl = wrapper.querySelector('.aislash-editor-input-readonly');
        let text = (inputEl?.textContent || wrapper.textContent || '').trim();
        let quoted: { text: string } | undefined;
        const quoteEl = inputEl?.querySelector('blockquote');
        if (inputEl && quoteEl) {
          const qt = (quoteEl.textContent || '').trim();
          if (qt) {
            quoted = { text: qt };
            const clone = inputEl.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('blockquote').forEach((el) => el.remove());
            const rest = (clone.textContent || '').trim();
            if (rest) text = rest;
          }
        }
        const mentionEls = wrapper.querySelectorAll('.mention');
        const mentions = Array.from(mentionEls).map(m => ({
          name: m.getAttribute('data-mention-name') || (m.textContent || '').trim(),
          mentionType: m.getAttribute('data-typeahead-type') || 'unknown',
        }));

        elements.push({
          type: 'human' as const,
          id: messageId,
          flatIndex,
          text,
          mentions,
          ...(quoted ? { quoted } : {}),
        });
        rawEl.parsedAs = 'human';
        continue;
      }

      // --- AI assistant message ---
      if (role === 'ai' && kind === 'assistant') {
        const markdownRoot = wrapper.querySelector('.markdown-root');
        const text = (markdownRoot?.textContent || wrapper.textContent || '').trim();
        const html = markdownRoot?.innerHTML || '';

        const codeBlockEls = wrapper.querySelectorAll('.composer-message-codeblock, .composer-code-block-container');
        const codeBlocks = Array.from(codeBlockEls).map(cb => extractCodeBlockItem(cb));

        elements.push({
          type: 'assistant' as const,
          id: messageId,
          flatIndex,
          text,
          html,
          codeBlocks,
        });
        rawEl.parsedAs = 'assistant';
        continue;
      }

      // --- Tool call ---
      if (role === 'ai' && kind === 'tool') {
        const parsedTool = extractAiTool(msgEl as Element, flatIndex, messageId, rawEl);
        if (parsedTool) {
          elements.push(parsedTool.element);
          rawEl.parsedAs = parsedTool.parsedAs;
        }
        continue;
      }

      // --- Fallback: step-group inside a message-group wrapper ---
      if (!role && wrapper.querySelector('.composer-message-group')) {
        const collapseEl = wrapper.querySelector('.ui-collapsible-header');
        if (collapseEl) {
          const spans = collapseEl.querySelectorAll(':scope > span');
          let action = '';
          let detail = '';
          let duration = '';
          const durationFromTextFb = (raw: string): string => {
            const t = raw.trim();
            const forM = t.match(/\bfor\s+([\d.]+\s*s(?:ec(?:onds?)?)?)\b/i);
            if (forM) return forM[1].replace(/\s+/g, '');
            const bareM = t.match(/^([\d.]+\s*s(?:ec(?:onds?)?)?)$/i);
            if (bareM) return bareM[1].replace(/\s+/g, '');
            return '';
          };
          const isDurationOnlySpanFb = (raw: string): boolean => {
            const t = raw.trim();
            if (/^for\s+/i.test(t)) return false;
            return !!durationFromTextFb(t) && t.length <= 20;
          };
          for (const s of Array.from(spans)) {
            if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
            const t = (s.textContent || '').trim();
            if (!t) continue;
            const d = durationFromTextFb(t);
            if (d && !duration) duration = d;
            if (isDurationOnlySpanFb(t)) continue;
            if (!action) { action = t; continue; }
            if (t.startsWith('for ')) { duration = duration || t.replace(/^for\s+/i, '').trim(); detail = t; }
            else { detail = detail || t; }
          }
          if (!duration) {
            const fullHeader = (collapseEl.textContent || '').replace(/\s+/g, ' ').trim();
            duration = durationFromTextFb(fullHeader);
          }
          elements.push({
            type: 'thought' as const,
            id: `thought-${flatIndex}`,
            flatIndex,
            duration,
            action: action || undefined,
            detail: detail || undefined,
          });
          rawEl.parsedAs = 'thought:fallback';
        }
      }
    }

    // --- Orphan activity indicators (not inside any message wrapper) ---
    const _orphanIndicators: Array<{ cls: string; text: string; parentCls: string }> = [];
    const allIndicators = container.querySelectorAll('.loading-indicator-v3, .make-shine');
    for (const ind of Array.from(allIndicators)) {
      if (ind.closest('[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role]')) continue;
      _orphanIndicators.push({
        cls: ind.className.substring(0, 200),
        text: (ind.textContent || '').trim().substring(0, 120),
        parentCls: (ind.parentElement?.className || '').substring(0, 200),
      });
    }

    // --- Approval extraction. Two paths:
    //
    // Primary (per-card): each pending shell tool-call card carries its own
    // Run / Skip / Allowlist buttons plus the actual command text. We surface
    // one approval entry per card with the command as the description — much
    // more useful than just the button label.
    //
    // Fallback (legacy/non-shell): older Cursor builds and non-shell approval
    // surfaces. Collapses everything found into a single entry.
    //
    // Both paths must:
    //   - scope to `container` (otherwise multi-agent workbenches leak
    //     buttons across composers and approvals never clear), and
    //   - skip elements with aria-haspopup (Cursor's "Auto-Run in Sandbox"
    //     mode-dropdown trigger has text "Auto-Run …" and would match a
    //     generic "Run" textMatch — but it opens a settings menu, not an
    //     approval action).
    const pendingApprovals: CursorState['pendingApprovals'] = [];
    const isMenuTrigger = (btn: Element): boolean => {
      const popup = btn.getAttribute('aria-haspopup');
      return popup === 'menu' || popup === 'true' || popup === 'listbox';
    };
    // Excludes controls that are NOT approval actions from the loose
    // text-match fallback below:
    //  - tool/step-group collapsible headers (their text starts with verbs like
    //    "Running …"/"Ran …" that spuriously contain "Run"),
    //  - the composer's own Run/Stop controls (nearest ancestor is the prompt
    //    input rather than a tool card).
    // The primary per-card path above is unaffected — it uses the real
    // `.ui-shell-tool-call__approval-row` wrapper. Legacy `.composer-run-button`
    // / `.composer-skip-button` approvals are intentionally NOT excluded, since
    // in older builds those ARE the approval controls.
    const isToolHeaderOrComposerControl = (btn: Element): boolean => {
      if (btn.closest('.ui-collapsible-header')) return true;
      if (btn.closest('[class*="prompt-input"]')) return true;
      return false;
    };
    const cleanBtnLabel = (raw: string): string =>
      raw.replace(/\s*(Shift\+)?⏎\s*/g, '').replace(/\s+/g, ' ').trim();

    const seenCards = new Set<Element>();
    const approvalRows = container.querySelectorAll('.ui-shell-tool-call__approval-row');
    for (const row of Array.from(approvalRows)) {
      const card = row.closest('.ui-tool-call-card') || row.closest('.ui-shell-tool-call');
      if (!card || seenCards.has(card)) continue;

      const actions: CursorState['pendingApprovals'][0]['actions'] = [];

      const runBtn = row.querySelector('button.ui-shell-tool-call__run-btn');
      if (runBtn && !isMenuTrigger(runBtn)) {
        actions.push({
          label: cleanBtnLabel(runBtn.textContent || '') || 'Run',
          type: 'approve',
          selectorPath: buildSelectorPath(runBtn),
        });
      }
      const allowlistBtn = row.querySelector('button.ui-shell-tool-call__allowlist-button');
      if (allowlistBtn && !isMenuTrigger(allowlistBtn)) {
        const lblEl = allowlistBtn.querySelector('.ui-shell-tool-call__allowlist-button-label');
        actions.push({
          label: cleanBtnLabel(lblEl?.textContent || allowlistBtn.textContent || '') || 'Allowlist',
          type: 'approve',
          selectorPath: buildSelectorPath(allowlistBtn),
        });
      }
      const skipBtn = row.querySelector('button.ui-shell-tool-call__skip-btn');
      if (skipBtn && !isMenuTrigger(skipBtn)) {
        actions.push({
          label: cleanBtnLabel(skipBtn.textContent || '') || 'Skip',
          type: 'reject',
          selectorPath: buildSelectorPath(skipBtn),
        });
      }

      if (!actions.some((a) => a.type === 'approve')) continue;
      seenCards.add(card);

      const cmdEl = card.querySelector('.ui-shell-tool-call__command');
      const cmdText = (cmdEl?.textContent || '')
        .trim()
        .replace(/^\$\s*/, '')
        .replace(/\s+/g, ' ')
        .substring(0, 240);
      const descEl = card.querySelector('.ui-shell-tool-call__description');
      const descText = (descEl?.textContent || '').trim().substring(0, 200);
      const description = cmdText || descText || 'Pending approval';

      // Stable per-card id — Cursor's tool-call id when available, falling
      // back to selector path. Keeps the entry consistent across polls.
      const bubble = card.closest('[data-tool-call-id]');
      const toolCallId = bubble?.getAttribute('data-tool-call-id') || buildSelectorPath(card);
      pendingApprovals.push({
        id: `tool:${toolCallId}`,
        description,
        actions,
      });
    }

    if (pendingApprovals.length === 0) {
      const approveButtons: { label: string; selector: string }[] = [];
      const rejectButtons: { label: string; selector: string }[] = [];
      const seenApproveBtns = new Set<Element>();
      const seenRejectBtns = new Set<Element>();

      for (const sel of approveSelectors) {
        try {
          const btns = container.querySelectorAll(sel);
          for (const btn of Array.from(btns)) {
            if (seenApproveBtns.has(btn) || isMenuTrigger(btn)) continue;
            const label = btn.textContent?.trim() || btn.getAttribute('aria-label') || '';
            if (label) {
              seenApproveBtns.add(btn);
              approveButtons.push({ label, selector: buildSelectorPath(btn) });
            }
          }
        } catch { /* skip */ }
      }
      if (approveButtons.length === 0 && approveTextMatch.length > 0) {
        for (const btn of Array.from(container.querySelectorAll('button'))) {
          if (seenApproveBtns.has(btn) || isMenuTrigger(btn) || isToolHeaderOrComposerControl(btn)) continue;
          const text = `${btn.textContent?.trim() || ''} ${btn.getAttribute('aria-label') || ''}`.toLowerCase();
          for (const pat of approveTextMatch) {
            if (text.includes(pat.toLowerCase())) {
              seenApproveBtns.add(btn);
              approveButtons.push({ label: btn.textContent?.trim() || pat, selector: buildSelectorPath(btn) });
              break;
            }
          }
        }
      }

      for (const sel of rejectSelectors) {
        try {
          const btns = container.querySelectorAll(sel);
          for (const btn of Array.from(btns)) {
            if (seenRejectBtns.has(btn) || isMenuTrigger(btn)) continue;
            const label = btn.textContent?.trim() || btn.getAttribute('aria-label') || '';
            if (label) {
              seenRejectBtns.add(btn);
              rejectButtons.push({ label, selector: buildSelectorPath(btn) });
            }
          }
        } catch { /* skip */ }
      }
      if (rejectButtons.length === 0 && rejectTextMatch.length > 0) {
        for (const btn of Array.from(container.querySelectorAll('button'))) {
          if (seenRejectBtns.has(btn) || isMenuTrigger(btn) || isToolHeaderOrComposerControl(btn)) continue;
          const text = `${btn.textContent?.trim() || ''} ${btn.getAttribute('aria-label') || ''}`.toLowerCase();
          for (const pat of rejectTextMatch) {
            if (text.includes(pat.toLowerCase())) {
              seenRejectBtns.add(btn);
              rejectButtons.push({ label: btn.textContent?.trim() || pat, selector: buildSelectorPath(btn) });
              break;
            }
          }
        }
      }

      if (approveButtons.length > 0 || rejectButtons.length > 0) {
        const actions: CursorState['pendingApprovals'][0]['actions'] = [];
        for (const btn of approveButtons) {
          actions.push({
            label: btn.label,
            type: btn.label.toLowerCase().includes('all') ? 'approve_all' : 'approve',
            selectorPath: btn.selector,
          });
        }
        for (const btn of rejectButtons) {
          actions.push({ label: btn.label, type: 'reject', selectorPath: btn.selector });
        }
        const idParts = approveButtons.map(b => b.label).join(',') + '|' + rejectButtons.map(b => b.label).join(',');
        pendingApprovals.push({
          id: idParts,
          description: approveButtons[0]?.label || 'Pending approval',
          actions,
        });
      }
    }

    // --- Agent status ---
    const statusEl = findFirst(statusSelectors);
    let agentStatus: CursorState['agentStatus'] = 'idle';
    if (statusEl) {
      const combined = `${(statusEl.textContent || '').toLowerCase()} ${statusEl.classList.toString().toLowerCase()}`;
      if (combined.includes('think')) agentStatus = 'thinking';
      else if (combined.includes('generat')) agentStatus = 'generating';
      else if (combined.includes('running') || combined.includes('execut')) agentStatus = 'running_tool';
      else if (combined.includes('approv') || combined.includes('wait')) agentStatus = 'waiting_approval';
      else if (combined.includes('error') || combined.includes('fail')) agentStatus = 'error';
    }
    if (pendingApprovals.length > 0) agentStatus = 'waiting_approval';

    // Element-based status detection removed: tool loading badges and
    // run_command elements persist in the DOM long after completion.
    // Shimmer + .loading-indicator-v3 (checked below) are the ground truth.

    const inputEl = findFirst(inputSelectors);

    // --- Chat tabs from agent sidebar/history cells ---
    const chatTabs: ChatTab[] = [];

    function cleanTabTitle(raw: string): string {
      let t = raw.trim().replace(/\s+/g, ' ');
      t = t.replace(/(@[\w./]+)+\s*$/, '');
      return t.trim().substring(0, 120);
    }

    try {
      const seenTitles = new Set<string>();
      let scopeRoot: Element | null = null;
      if (containerComposerId) {
        const allCells = document.querySelectorAll('.agent-sidebar-cell');
        for (const cell of Array.from(allCells)) {
          const cid = cell.getAttribute('data-composer-id') || cell.closest('[data-composer-id]')?.getAttribute('data-composer-id');
          if (cid === containerComposerId) {
            scopeRoot = cell.closest('.agent-sidebar-project-cell') || document.body;
            break;
          }
        }
      }
      if (!scopeRoot && windowTitle) {
        const projectName = projectNameFromTitle(windowTitle).toLowerCase();
        if (projectName) {
          const projectCells = document.querySelectorAll('.agent-sidebar-project-cell');
          for (const cell of Array.from(projectCells)) {
            const labelEl = cell.querySelector('.agent-sidebar-section-title-text') || cell.querySelector('.agent-sidebar-workspace-name') || cell;
            const label = (labelEl.textContent || '').trim().toLowerCase();
            const firstWord = (label.split(/[\s\[\]\-]/)[0] || '').toLowerCase();
            if (label.includes(projectName) || projectName.includes(firstWord) || firstWord === projectName) {
              scopeRoot = cell;
              break;
            }
          }
        }
      }
      // Cursor Agents unified window: glass sidebar rows (replaces .agent-sidebar-cell in newer builds)
      const glassTabRoots = document.querySelectorAll(
        '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
      );
      if (glassTabRoots.length > 0) {
        for (const tab of Array.from(glassTabRoots)) {
          const labelEl = tab.querySelector('.ui-sidebar-menu-button-label');
          const rawAgentTitle = (labelEl?.textContent || '').trim();
          if (!rawAgentTitle) continue;

          const group = tab.closest('.ui-sidebar-group');
          const groupTitleEl = group?.querySelector('.ui-sidebar-group-label-title');
          const rawGroupTitle = (groupTitleEl?.textContent || '').trim();

          let displayTitle = cleanTabTitle(rawAgentTitle);
          if (rawGroupTitle) {
            const g = cleanTabTitle(rawGroupTitle);
            if (g) {
              displayTitle = `${g} / ${cleanTabTitle(rawAgentTitle)}`.substring(0, 120);
            }
          }

          if (seenTitles.has(displayTitle)) continue;
          seenTitles.add(displayTitle);

          const composerId =
            tab.getAttribute('data-composer-id')
            || tab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
            || `glass:${displayTitle}`;

          const isActive = tab.getAttribute('data-active') === 'true';

          chatTabs.push({
            composerId,
            title: displayTitle,
            isActive,
            status: isActive ? 'active' : 'idle',
            selectorPath: buildSelectorPath(tab),
          });
        }

        if (containerComposerId) {
          let matched = false;
          for (const t of chatTabs) {
            if (t.composerId === containerComposerId) {
              matched = true;
              t.isActive = true;
              t.status = 'active';
            }
          }
          if (matched) {
            for (const t of chatTabs) {
              if (t.composerId !== containerComposerId) {
                t.isActive = false;
                t.status = 'idle';
              }
            }
          }
        }
      }

      for (const sel of chatTabSelectors) {
        if (chatTabs.length > 0) break;
        let tabItems: NodeListOf<Element>;
        try {
          const root: Element | Document = scopeRoot || document;
          tabItems = root.querySelectorAll(sel);
        } catch {
          continue;
        }
        if (tabItems.length === 0) continue;
        for (const tab of Array.from(tabItems)) {
          if (scopeRoot && !scopeRoot.contains(tab)) continue;
          const titleEl = tab.querySelector('.agent-sidebar-cell-text');
          const rawTitle = titleEl
            ? (titleEl.textContent || '').trim()
            : (tab.getAttribute('aria-label') || tab.textContent || '').trim();
          const title = cleanTabTitle(rawTitle);
          if (!title || seenTitles.has(title)) continue;
          seenTitles.add(title);

          const composerId = tab.getAttribute('data-composer-id')
            || tab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
            || `tab-${chatTabs.length}`;
          const selectedAttr = tab.getAttribute('data-selected');
          const highlightedAttr = tab.getAttribute('data-highlighted');
          const isActive = selectedAttr === 'true'
            || highlightedAttr === 'true'
            || tab.classList.contains('selected')
            || tab.classList.contains('active');

          chatTabs.push({
            composerId,
            title,
            isActive,
            status: isActive ? 'active' : 'idle',
            selectorPath: buildSelectorPath(tab),
          });
        }
        if (chatTabs.length > 0) {
          if (containerComposerId) {
            let matched = false;
            for (const t of chatTabs) {
              const match = t.composerId === containerComposerId;
              if (match) {
                matched = true;
                t.isActive = true;
                t.status = 'active';
              }
            }
            if (matched) {
              // composerId match found — mark non-matching tabs inactive
              for (const t of chatTabs) {
                if (t.composerId !== containerComposerId) {
                  t.isActive = false;
                  t.status = 'idle';
                }
              }
            }
            // If composerId matching failed, keep original isActive from DOM attributes
            // (data-selected, data-highlighted, .selected, .active)
          }
          break;
        }
      }
    } catch { /* skip */ }

    // --- Workspace folders (Cursor agent sidebar) ---
    // Cursor's "Cursor Agents" overview groups chats under workspace/repo
    // sections. Extract *all* of them so folders that aren't currently open are
    // still visible on the remote. Each section:
    //   section[data-sidebar-workspace-section-root]
    //     ├─ .ui-sidebar-section-head .ui-sidebar-label-row-title  (folder name)
    //     └─ .glass-sidebar-agent-list-container li.ui-sidebar-menu-item (agents)
    const folders: WorkspaceFolder[] = [];
    // Cursor's overview sidebar rows carry no data-composer-id attribute; the
    // composer/agent id lives in the React fiber props (`agentId`). Walk up the
    // fiber from the row element to find it so tapping a row can reliably open
    // the chat via the workbench `composer.openComposer` command.
    const composerIdFromRow = (li: Element): string => {
      const attrId = li.getAttribute('data-composer-id')
        || li.querySelector('[data-composer-id]')?.getAttribute('data-composer-id')
        || '';
      if (attrId) return attrId;
      try {
        const fiberKey = Object.keys(li).find((k) => k.startsWith('__reactFiber$'));
        let fiber = fiberKey ? (li as unknown as Record<string, unknown>)[fiberKey] : null;
        let depth = 0;
        while (fiber && depth < 20) {
          const props = (fiber as { memoizedProps?: Record<string, unknown> }).memoizedProps;
          const agentId = props?.agentId;
          if (typeof agentId === 'string' && agentId) return agentId;
          fiber = (fiber as { return?: unknown }).return ?? null;
          depth++;
        }
      } catch { /* skip */ }
      return '';
    };
    const isActiveFromRow = (li: Element, btn: Element | null): boolean => {
      if (btn?.getAttribute('data-active') === 'true'
        || li.getAttribute('data-active') === 'true') return true;
      try {
        const fiberKey = Object.keys(li).find((k) => k.startsWith('__reactFiber$'));
        let fiber = fiberKey ? (li as unknown as Record<string, unknown>)[fiberKey] : null;
        let depth = 0;
        while (fiber && depth < 20) {
          const props = (fiber as { memoizedProps?: Record<string, unknown> }).memoizedProps;
          if (props && typeof props.isActive === 'boolean') return props.isActive;
          fiber = (fiber as { return?: unknown }).return ?? null;
          depth++;
        }
      } catch { /* skip */ }
      return false;
    };
    try {
      const sectionEls = document.querySelectorAll('section[data-sidebar-workspace-section-root]');
      for (const section of Array.from(sectionEls)) {
        const head = section.querySelector('.ui-sidebar-section-head');
        const name = cleanTabTitle(
          (head?.querySelector('.ui-sidebar-label-row-title')?.textContent || '').trim()
        );
        if (!name) continue;
        const sectionId = section.getAttribute('data-agent-drop-section-id') || `folder:${name}`;
        const kind: WorkspaceFolder['kind'] = sectionId.startsWith('repo:') ? 'repo' : 'workspace';

        const agents: FolderAgent[] = [];
        // Agent rows normally live in .glass-sidebar-agent-list-container,
        // but some sections (single-repo workspaces, empty folders) render
        // their li.ui-sidebar-menu-item directly inside the section root.
        const listContainer = section.querySelector('.glass-sidebar-agent-list-container');
        const items = listContainer
          ? Array.from(listContainer.querySelectorAll('li.ui-sidebar-menu-item'))
          : Array.from(section.querySelectorAll('li.ui-sidebar-menu-item'));
        for (const li of items) {
          const btn = li.querySelector(
            '[data-sidebar-menu-button], .ui-sidebar-menu-button, [role="button"], button'
          );
          const labelEl = li.querySelector(
            '.ui-sidebar-menu-button-label, .ui-sidebar-label-row-title'
          );
          const title = cleanTabTitle(
            (labelEl?.textContent || li.textContent || '').trim()
          );
          if (!title) continue;
          const composerId =
            composerIdFromRow(li)
            || btn?.getAttribute('data-composer-id')
            || li.getAttribute('data-composer-id')
            || (btn?.closest('[data-composer-id]')?.getAttribute('data-composer-id'))
            || '';
          const isActive = isActiveFromRow(li, btn);
          agents.push({
            title,
            composerId,
            sectionId,
            isActive,
            selectorPath: buildSelectorPath(li),
          });
        }

        folders.push({ name, sectionId, kind, isCurrent: false, agents });
      }

      // Mark the folder that corresponds to the relay's home window as current,
      // by matching its name against the window title / active agent area.
      if (folders.length > 0 && windowTitle) {
        const projectName = projectNameFromTitle(windowTitle).toLowerCase();
        if (projectName) {
          for (const f of folders) {
            if (f.name.toLowerCase() === projectName) { f.isCurrent = true; break; }
          }
        }
      }
    } catch { /* skip */ }

    // --- Mode extraction ---
    const modeEl = findFirst(modeSelectors);
    let currentMode = 'agent';
    if (modeEl) {
      currentMode = modeEl.getAttribute('data-mode') || 'agent';
    }
    const mode: ModeInfo = {
      current: currentMode,
      available: [
        { id: 'agent', label: 'Agent', icon: 'infinity' },
        { id: 'plan', label: 'Plan', icon: 'todos' },
        { id: 'debug', label: 'Debug', icon: 'bug' },
        { id: 'chat', label: 'Ask', icon: 'chat' },
      ],
    };

    // --- Model extraction ---
    // Skip plan-scoped model dropdowns (id starts with "plan-exec-model") — those
    // show the model for a specific plan, not the composer-level model.
    let modelEl: Element | null = null;
    for (const sel of modelSelectors) {
      try {
        const candidates = document.querySelectorAll(sel);
        for (const c of Array.from(candidates)) {
          const cId = c.getAttribute('id') || '';
          if (!cId.startsWith('plan-exec-model')) {
            modelEl = c;
            break;
          }
        }
        if (modelEl) break;
      } catch { /* skip */ }
    }
    let modelName = '';
    let modelId = '';
    if (modelEl) {
      const spans = modelEl.querySelectorAll('span');
      for (const s of Array.from(spans)) {
        const t = (s.textContent || '').trim();
        if (t && !t.includes('chevron') && t.length > 1) {
          modelName = t;
          break;
        }
      }
      modelId = modelEl.getAttribute('id') || '';
    }
    const model: ModelInfo = {
      current: modelName || 'Auto',
      currentId: modelId,
    };

    // --- Raw activity signals (objective DOM snapshot for recording) ---
    const _shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }> = [];
    const hasLoadingIndicator = container.querySelector('.loading-indicator-v3') !== null;
    const hasLoadingTool = container.querySelector('[data-tool-status="loading"]') !== null;

    // --- Ground-truth "working" signal for the abort control ---
    // Cursor renders a stop control for the entire turn: a running tool's
    // "Stop command" button (`.ui-shell-tool-call__glass-stop`) and/or the
    // composer's send↔stop toggle ("Stop generation"). Presence of any of
    // these means the agent is actively producing something right now. We
    // scope the selectors tightly (exact aria / known classes) so unrelated
    // "Stop" controls elsewhere in the workbench (e.g. the debug toolbar)
    // don't keep the abort button visible when the agent is truly idle, and
    // require the element to be visible — Cursor sometimes leaves completed
    // tool controls in the DOM hidden rather than removing them.
    const isVisible = (el: Element | null): boolean => {
      if (!el) return false;
      const h = el as HTMLElement;
      if (h.offsetParent === null && getComputedStyle(h).position !== 'fixed') return false;
      const rects = h.getClientRects();
      return rects.length > 0;
    };
    const canAbort =
      isVisible(container.querySelector('.ui-shell-tool-call__glass-stop')) ||
      isVisible(document.querySelector('.ui-shell-tool-call__glass-stop')) ||
      isVisible(document.querySelector('button[aria-label="Stop generation"]')) ||
      isVisible(document.querySelector('.ui-prompt-input-submit-button[aria-label*="Stop" i]')) ||
      isVisible(document.querySelector('.ui-prompt-input-submit-button[aria-label*="Cancel" i]')) ||
      !!hasLoadingIndicator;
    const shineEls = container.querySelectorAll('.make-shine');
    for (const sh of Array.from(shineEls).reverse()) {
      const inToolCall = !!sh.closest('[data-tool-call-id]') || !!sh.closest('.composer-terminal-tool');
      const header = sh.closest('.ui-collapsible-header');
      let text = '';
      if (header) {
        const spans = header.querySelectorAll(':scope > span');
        const parts: string[] = [];
        for (const s of Array.from(spans)) {
          if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
          const t = (s.textContent || '').trim();
          if (t) parts.push(t);
        }
        text = parts.join(' ');
      } else if (sh.classList.contains('composer-terminal-top-header-description') ||
                 sh.closest('.composer-terminal-top-header-text')) {
        text = (sh.textContent || '').trim();
      } else {
        const descEl = (sh.closest('[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role]') || sh.parentElement)
          ?.querySelector('.composer-terminal-top-header-description, .ui-tool-call-line-action, .ui-edit-tool-call__filename');
        text = descEl ? (descEl.textContent || '').trim() : (sh.textContent || '').trim();
      }
      if (text.length > 2) {
        const entry = { text: text.substring(0, 80), inToolCall, inHeader: !!header };
        _shimmer.push(entry);
      }
    }

    const _rawSignals = {
      shimmer: _shimmer,
      loadingIndicator: hasLoadingIndicator,
      statusEl: statusEl ? { text: (statusEl.textContent || '').trim(), classes: statusEl.className } : undefined,
      elements: _rawElements,
      orphanIndicators: _orphanIndicators,
    };

    // Queued (not-yet-sent) messages, of which Cursor ships two shapes:
    //   • Newer builds: `.ui-tray--queued` tray → `.ui-tray-rows[data-queue-count]`
    //     holding `.ui-tray-row[data-queue-item-id]` rows. The message text is
    //     the row's `aria-label` / `.ui-tray-row__label`, and the per-row
    //     "Send now" (`data-queue-action="steer"`), Edit and Remove buttons are
    //     only MOUNTED while the row is hovered/focused — so they cannot be
    //     selected by CSS up front; the executor reveals them by hovering.
    //   • Older builds: `.composer-toolbar-queue-item` rows with the query in
    //     `data-queue-item-query`, under `#composer-toolbar-section`.
    const queueItems: {
      id: string;
      text: string;
      sendSelectorPath?: string;
      removeSelectorPath?: string;
    }[] = [];
    let queueLabel: string | undefined;

    // --- Newer tray shape ---
    const queuedTray = document.querySelector('.ui-tray--queued')
      ?? document.querySelector('.ui-tray-rows[data-queue-count]')?.closest('.ui-tray')
      ?? null;
    const trayRowsRoot = queuedTray?.querySelector('.ui-tray-rows[data-queue-count]')
      ?? document.querySelector('.ui-tray-rows[data-queue-count]')
      ?? null;
    if (queuedTray || trayRowsRoot) {
      const headerTitle = queuedTray?.querySelector('[data-component="tray-header-title"]');
      const headerText = (headerTitle?.textContent || '').trim();
      if (headerText) queueLabel = headerText;
      const count = trayRowsRoot?.getAttribute('data-queue-count');
      if (!queueLabel && count) queueLabel = `${count} Queued`;
    }
    const trayRows = Array.from(
      (trayRowsRoot ?? document).querySelectorAll('.ui-tray-row[data-queue-item-id]')
    );
    for (const rowEl of trayRows) {
      const qid = rowEl.getAttribute('data-queue-item-id') || '';
      const labelEl = rowEl.querySelector('.ui-tray-row__label');
      const qtext = (labelEl?.textContent || rowEl.getAttribute('aria-label') || '').trim()
        .replace(/\s+/g, ' ');
      if (qid || qtext) queueItems.push({ id: qid || `qi-${queueItems.length}`, text: qtext });
    }

    // --- Older toolbar shape (only when the tray shape found nothing) ---
    if (queueItems.length === 0) {
      const toolbarSection = document.querySelector('#composer-toolbar-section');
      if (toolbarSection) {
        const headerLabel = toolbarSection.querySelector('.composer-toolbar-section-header-label');
        const headerText = (headerLabel?.textContent || '').trim();
        if (headerText) queueLabel = headerText;
        if (!queueLabel) {
          for (const lc of Array.from(toolbarSection.querySelectorAll('*'))) {
            const lt = (lc.textContent || '').trim();
            if (lt && /queued/i.test(lt)) {
              queueLabel = lt;
              break;
            }
          }
        }
      }
      const queueRows = toolbarSection
        ? Array.from(toolbarSection.querySelectorAll('.composer-toolbar-queue-item'))
        : Array.from(document.querySelectorAll('.composer-toolbar-queue-item'));
      for (const item of queueRows) {
        const qid = item.getAttribute('data-queue-item-id') || '';
        let qtext = (item.getAttribute('data-queue-item-query') || '').trim();
        if (!qtext) {
          const ro = item.querySelector('.aislash-editor-input-readonly');
          qtext = (ro?.textContent || '').trim();
        }
        const row: {
          id: string;
          text: string;
          sendSelectorPath?: string;
          removeSelectorPath?: string;
        } = { id: qid || `qi-${queueItems.length}`, text: qtext };
        // Anchored selectors keyed on Cursor's own stable attributes
        // (`data-queue-item-id`, `data-queue-action`) rather than the brittle
        // body-down nth-of-type chain buildSelectorPath produces.
        const sendWrap = item.querySelector('[data-queue-action="send"], [data-queue-action="steer"]');
        const sendBtn = sendWrap?.querySelector('.anysphere-icon-button') ?? sendWrap;
        if (sendBtn) {
          const action = sendWrap?.getAttribute('data-queue-action') ?? '';
          row.sendSelectorPath = qid && (action === 'send' || action === 'steer')
            ? `[data-queue-item-id="${CSS.escape(qid)}"] [data-queue-action="${action}"] .anysphere-icon-button`
            : buildSelectorPath(sendBtn);
        }
        const removeWrap = item.querySelector('[data-queue-action="remove"]');
        const removeBtn = removeWrap?.querySelector('.anysphere-icon-button') ?? removeWrap;
        if (removeBtn) {
          row.removeSelectorPath = qid
            ? `[data-queue-item-id="${CSS.escape(qid)}"] [data-queue-action="remove"] .anysphere-icon-button`
            : buildSelectorPath(removeBtn);
        }
        if (qid || qtext) queueItems.push(row);
      }
    }

    // --- Questionnaire widget ---
    // Cursor ships two shapes for the ask-question UI:
    //   • New (2026+): a floating tray `.ui-tray.glass-questionnaire-tray` with
    //     `.ui-tray-step` questions, `.ui-tray-option` rows (badge letter +
    //     label), a freeform `questionnaire-freeform-option`, and a
    //     `.ui-tray-footer__primary` Continue button. The transcript only shows
    //     a generic "Asking questions" tool row, so this tray is the real UI.
    //   • Legacy: an inline `.composer-questionnaire-toolbar` in the composer.
    // Parse the new tray first, then fall back to the legacy toolbar.
    type QOption = { letter: string; label: string; isFreeform: boolean; selectorPath: string; freeformInputSelectorPath?: string };
    type QQuestion = { number: string; text: string; options: QOption[]; isActive: boolean };
    let questionnaire: {
      questions: QQuestion[];
      activeIndex: number;
      totalLabel: string;
      skipSelectorPath: string;
      continueSelectorPath: string;
      continueDisabled: boolean;
    } | null = null;

    // Anchored class-based paths, like the Skip/Continue actions below.
    // buildSelectorPath's body-down tag chains go stale between poll and
    // click, and they target the letter <button> whose text can never pass
    // the resolver's label check (public#50). Target the option ROW instead:
    // it carries role="button" and clicking it selects the option.
    const nthOfType = (el: Element): number => {
      const parent = el.parentElement;
      if (!parent) return 1;
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      return sameTag.indexOf(el) + 1;
    };

    const qTray = document.querySelector('.glass-questionnaire-tray')
      ?? Array.from(document.querySelectorAll('.ui-tray')).find((t) => t.querySelector('.ui-tray-option'))
      ?? null;
    if (qTray) {
      const steps = Array.from(qTray.querySelectorAll('.ui-tray-step'));
      const questions: QQuestion[] = [];
      let activeIdx = 0;
      for (let qi = 0; qi < steps.length; qi++) {
        const stepEl = steps[qi];
        const isActive = stepEl.getAttribute('data-active') === 'true';
        if (isActive) activeIdx = qi;
        const num = (stepEl.querySelector('.ui-tray-step__number')?.textContent || '').trim();
        const mdRoot = stepEl.querySelector('.ui-tray-step__title .markdown-root')
          ?? stepEl.querySelector('.markdown-root');
        const text = (mdRoot?.textContent || '').trim();
        const optionEls = Array.from(stepEl.querySelectorAll('.ui-tray-option'));
        const options: QOption[] = [];
        for (const optEl of optionEls) {
          const letter = (optEl.querySelector('.ui-tray-option__badge')?.textContent || '').trim();
          const isFreeform = optEl.classList.contains('questionnaire-freeform-option')
            || optEl.getAttribute('data-text-input') === 'true';
          const label = isFreeform
            ? 'Other'
            : (optEl.querySelector('.ui-tray-option__label')?.textContent || '').trim();
          const selectorPath =
            `.glass-questionnaire-tray .ui-tray-step:nth-of-type(${nthOfType(stepEl)})` +
            ` .ui-tray-option:nth-of-type(${nthOfType(optEl)})`;
          // Freeform ("Other"): Cursor mounts its rich-text editor INSIDE the
          // option row only AFTER the row is clicked, so it never exists at
          // extraction time. Point the client at the stable option-row path and
          // let the executor resolve the editor inside it when submitting
          // (`setAnswerText`). A frozen buildSelectorPath input chain would go
          // stale and miss the late-mounted ProseMirror element.
          const freeformInputSelectorPath = isFreeform ? selectorPath : undefined;
          options.push({ letter, label, isFreeform, selectorPath, ...(freeformInputSelectorPath ? { freeformInputSelectorPath } : {}) });
        }
        questions.push({ number: num, text, options, isActive });
      }

      let skipPath = '';
      let continuePath = '';
      let continueDisabled = false;
      const footer = qTray.querySelector('.ui-tray-footer') ?? qTray;
      const footerButtons = Array.from(footer.querySelectorAll('button'));
      if (footerButtons.some((b) => /^skip\b/i.test((b.textContent || '').trim()))) {
        skipPath = '.glass-questionnaire-tray button[data-variant="text"]';
      }
      const contBtn = footerButtons.find((b) => /^continue\b/i.test((b.textContent || '').trim()));
      if (contBtn) {
        continuePath = '.glass-questionnaire-tray .ui-tray-footer__primary button';
        continueDisabled = contBtn.hasAttribute('disabled') || contBtn.getAttribute('data-disabled') !== null;
      }

      const headerTitle = (qTray.querySelector('[data-component="tray-header-title"]')?.textContent || '').trim();
      const totalLabel = steps.length > 1 ? `${activeIdx + 1} / ${steps.length}` : headerTitle;

      questionnaire = {
        questions,
        activeIndex: activeIdx,
        totalLabel,
        skipSelectorPath: skipPath,
        continueSelectorPath: continuePath,
        continueDisabled,
      };
    }

    const qToolbar = questionnaire ? null : document.querySelector('.composer-questionnaire-toolbar');
    if (qToolbar) {
      const stepperLabel = (qToolbar.querySelector('.composer-questionnaire-toolbar-stepper-label')?.textContent || '').trim();
      const questionEls = Array.from(qToolbar.querySelectorAll('.composer-questionnaire-toolbar-question'));
      const questions: QQuestion[] = [];
      let activeIdx = 0;
      for (let qi = 0; qi < questionEls.length; qi++) {
        const qEl = questionEls[qi];
        const isActive = qEl.classList.contains('composer-questionnaire-toolbar-question-active');
        if (isActive) activeIdx = qi;
        const num = (qEl.querySelector('.composer-questionnaire-toolbar-question-number')?.textContent || '').trim();
        const mdRoot = qEl.querySelector('.markdown-root');
        const text = (mdRoot?.textContent || '').trim();
        const optionEls = Array.from(qEl.querySelectorAll('.composer-questionnaire-toolbar-option'));
        const options: QOption[] = [];
        for (const optEl of optionEls) {
          const letterBtn = optEl.querySelector('.composer-questionnaire-toolbar-option-letter');
          const letter = (letterBtn?.textContent || '').trim();
          const isFreeform = optEl.classList.contains('composer-questionnaire-toolbar-option-freeform');
          const label = isFreeform ? 'Other' : (optEl.querySelector('.composer-questionnaire-toolbar-option-label')?.textContent || '').trim();
          const selectorPath =
            `.composer-questionnaire-toolbar-question:nth-of-type(${nthOfType(qEl)})` +
            ` .composer-questionnaire-toolbar-option:nth-of-type(${nthOfType(optEl)})`;
          // Freeform ("Other"): Cursor mounts its rich-text editor INSIDE the
          // option row only AFTER the row is clicked, so it never exists at
          // extraction time. Point the client at the stable option-row path and
          // let the executor resolve the editor inside it when submitting
          // (`setAnswerText`). A frozen buildSelectorPath input chain would go
          // stale and miss the late-mounted ProseMirror element.
          const freeformInputSelectorPath = isFreeform ? selectorPath : undefined;
          options.push({ letter, label, isFreeform, selectorPath, ...(freeformInputSelectorPath ? { freeformInputSelectorPath } : {}) });
        }
        questions.push({ number: num, text, options, isActive });
      }

      let skipPath = '';
      let continuePath = '';
      let continueDisabled = false;
      const actionsContainer = qToolbar.querySelector('.composer-questionnaire-toolbar-actions');
      if (actionsContainer) {
        // Keep questionnaire action selectors in-extractor with the existing convention:
        // prefer legacy button classes, then fall back to Cursor 3.8+ data-click-ready divs.
        const findActionByLabel = (label: string): Element | null => {
          const expected = label.trim().toLowerCase();
          for (const child of Array.from(actionsContainer.querySelectorAll(':scope > div[data-click-ready]'))) {
            const truncateText = (child.querySelector('span.truncate')?.textContent || '').trim().toLowerCase();
            if (truncateText === expected) return child;
          }
          return null;
        };
        const stableClickReadyPath = (el: Element): string => {
          const childIndex = el.parentElement ? Array.from(el.parentElement.children).indexOf(el) + 1 : 1;
          return `.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(${childIndex})`;
        };
        const skipLegacy = actionsContainer.querySelector('.composer-skip-button');
        if (skipLegacy) {
          skipPath = buildSelectorPath(skipLegacy);
        } else {
          const skipFallback = findActionByLabel('Skip');
          if (skipFallback) skipPath = stableClickReadyPath(skipFallback);
        }
        const contLegacy = actionsContainer.querySelector('.composer-run-button');
        const contBtn = contLegacy || findActionByLabel('Continue');
        if (contBtn) {
          continuePath = contLegacy ? buildSelectorPath(contLegacy) : stableClickReadyPath(contBtn);
          continueDisabled = contBtn.getAttribute('data-disabled') === 'true';
        }
      }

      questionnaire = {
        questions,
        activeIndex: activeIdx,
        totalLabel: stepperLabel,
        skipSelectorPath: skipPath,
        continueSelectorPath: continuePath,
        continueDisabled,
      };
    }

    // --- Slash command menu (`/` in the composer) ---
    // Cursor renders the tray as `div[role="listbox"][aria-label="Slash commands"]`
    // with `button[role="option"][data-composer-tray-row]` rows. Only present while
    // the menu is open, so an empty array means "menu closed" (never stale).
    const slashCommands: { id: string; label: string; description: string; selected: boolean; index: number }[] = [];
    const slashList = document.querySelector('div[role="listbox"][aria-label="Slash commands"]');
    if (slashList) {
      const optionEls = Array.from(slashList.querySelectorAll('button[role="option"]'));
      for (let si = 0; si < optionEls.length; si++) {
        const optEl = optionEls[si];
        // The row's two direct children: an icon span and a text span. The text
        // span's first meaningful child is the label (e.g. "Ask"), the next is the
        // description ("Answer questions without making edits"). Using the second
        // child avoids "Ask" bleeding into "Answer…" via textContent concatenation.
        const textSpan = optEl.children.length >= 2 ? optEl.children[1] : optEl;
        const textParts: string[] = [];
        for (const node of Array.from(textSpan.querySelectorAll('span, div'))) {
          const t = (node.textContent || '').trim();
          if (t && textParts[textParts.length - 1] !== t) textParts.push(t);
        }
        const directText = Array.from(textSpan.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent || '').trim())
          .filter(Boolean)
          .join(' ');
        const label = (directText || textParts[0] || (optEl.textContent || '').trim()).slice(0, 80);
        const description = (textParts[textParts.length - 1] || '').slice(0, 160);
        // The slash token is Cursor's internal command id; the row's DOM id
        // (`_r_xxx_-N`) is a React useId and never stable, so key by position/label.
        slashCommands.push({
          id: label ? label.toLowerCase().replace(/\s+/g, '-') : `slash-${si}`,
          label,
          description: description === label ? '' : description,
          selected: optEl.getAttribute('aria-selected') === 'true',
          index: si + 1,
        });
      }
    }

    return {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus,
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      canAbort,
      agentStalled: false,
      agentStalledSince: null,
      messages: elements,
      pendingApprovals,
      inputAvailable: inputEl !== null,
      chatTabs,
      // The composer currently open in the pane. `container` is the chat panel,
      // which may stay mounted even when no chat is open (Agents overview), so
      // prefer the actual `.composer-bar.editor[data-composer-id]` element. This
      // lets the client auto-open the chat Cursor is already showing instead of
      // waiting for a manual tap.
      activeComposerId: (
        document.querySelector('.composer-bar.editor[data-composer-id]')?.getAttribute('data-composer-id')
        || document.querySelector('.agent-conversation-composer [data-composer-id]')?.getAttribute('data-composer-id')
        || (container.querySelector('[data-composer-id]')?.getAttribute('data-composer-id'))
        || containerComposerId
        || (chatTabs.find((t) => t.isActive)?.composerId ?? '')
      ),
      mode,
      model,
      windows: [],
      activeWindowId: '',
      composerQueue: {
        items: queueItems,
        ...(queueLabel ? { queueLabel } : {}),
        ...(queueItems.length > 0
          ? { kind: queueItems[0].sendSelectorPath ? 'toolbar' as const : 'tray' as const }
          : {}),
      },
      questionnaire,
      slashCommands,
      folders,
      _rawSignals,
    };
  } catch {
    return null;
  }
}

export class DOMExtractor {
  private selectors: SelectorConfig;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private client: CdpClient | null = null;
  private onExtract: (state: CursorState | null, errorMessage?: string | null) => void;
  private getWindowTitle: () => string;
  private loggedFirstExtraction = false;
  private basePollIntervalMs = 300;
  private currentPollIntervalMs = 300;
  private pollInFlight = false;
  private failureStreak = 0;
  private running = false;

  constructor(
    selectors: SelectorConfig,
    onExtract: (state: CursorState | null, errorMessage?: string | null) => void,
    getWindowTitle: () => string = () => ''
  ) {
    this.selectors = selectors;
    this.onExtract = onExtract;
    this.getWindowTitle = getWindowTitle;
  }

  start(client: CdpClient, intervalMs: number): void {
    this.client = client;
    this.stop();
    this.running = true;
    this.basePollIntervalMs = intervalMs;
    this.currentPollIntervalMs = intervalMs;
    this.failureStreak = 0;
    console.log(`[dom-extractor] Starting polling every ${intervalMs}ms`);
    this.scheduleNextPoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.currentPollIntervalMs = this.basePollIntervalMs;
    this.failureStreak = 0;
  }

  /**
   * Force an immediate re-extraction, bypassing the normal poll delay, and
   * reset the backoff so a previously failed poll does not keep us slow.
   *
   * When the phone reports the agent as "stalled" — the extracted DOM has
   * stopped changing while the state still claims the agent is working — the
   * user wants the relay to re-read Cursor *now* rather than wait up to a
   * backed-off interval. This kicks a fresh `Runtime.evaluate` immediately and
   * clears any failure backoff; if Cursor's renderer really has finished (or
   * unblocked), the next snapshot reflects it and the mismatch resolves without
   * the user reloading the page.
   *
   * Safe to call at any time; a no-op when not polling.
   */
  forceRefresh(): void {
    if (!this.running) return;
    this.failureStreak = 0;
    this.currentPollIntervalMs = this.basePollIntervalMs;
    this.pollInFlight = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.scheduleNextPoll(0);
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  private scheduleNextPoll(delayMs = this.currentPollIntervalMs): void {
    if (!this.running) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  private handleFailure(message: string): void {
    const timedOut = message.includes('timeout');
    this.failureStreak++;
    if (timedOut) {
      const nextInterval = Math.min(
        Math.max(this.basePollIntervalMs, this.basePollIntervalMs * (2 ** (this.failureStreak - 1))),
        MAX_POLL_BACKOFF_MS
      );
      if (nextInterval !== this.currentPollIntervalMs) {
        this.currentPollIntervalMs = nextInterval;
        console.warn(`[dom-extractor] Backing off poll interval to ${this.currentPollIntervalMs}ms after ${message}`);
      }
    }
    this.onExtract(null, message);
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) {
      this.scheduleNextPoll();
      return;
    }
    this.pollInFlight = true;

    if (!this.client || !this.client.isConnected()) {
      this.handleFailure('CDP client not connected');
      this.pollInFlight = false;
      this.scheduleNextPoll();
      return;
    }

    try {
      const state = await this.client.callFunctionWithTimeout(
        extractionFunction as (...args: never[]) => unknown,
        [
          this.selectors.chatContainer.strategies,
          this.selectors.approveButton.strategies,
          this.selectors.approveButton.textMatch ?? [],
          this.selectors.rejectButton.strategies,
          this.selectors.rejectButton.textMatch ?? [],
          this.selectors.chatInput.strategies,
          this.selectors.agentStatus.strategies,
          this.selectors.chatTabList?.strategies ?? [],
          this.selectors.modeDropdown?.strategies ?? [],
          this.selectors.modelDropdown?.strategies ?? [],
          this.getWindowTitle(),
        ],
        EVALUATE_TIMEOUT_MS
      ) as CursorState | null;

      const derivedState = state ? applyDerivedActivityToState(state) : null;
      this.failureStreak = 0;
      this.currentPollIntervalMs = this.basePollIntervalMs;

      if (derivedState && !this.loggedFirstExtraction) {
        this.loggedFirstExtraction = true;
        console.log(`[dom-extractor] First successful extraction:`);
        console.log(`  status: ${derivedState.agentStatus}${derivedState.agentActivityText ? ` (${derivedState.agentActivityText})` : ''}`);
        console.log(`  messages: ${derivedState.messages.length}`);
        console.log(`  approvals: ${derivedState.pendingApprovals.length}`);
        console.log(`  inputAvailable: ${derivedState.inputAvailable}`);
        console.log(`  chatTabs: ${derivedState.chatTabs.length}`);
        console.log(`  mode: ${derivedState.mode.current}, model: ${derivedState.model.current}`);
        if (derivedState.messages.length > 0) {
          const last = derivedState.messages[derivedState.messages.length - 1];
          const preview = last.type === 'human' ? last.text
            : last.type === 'assistant' ? last.text
            : last.type === 'tool' ? `${last.action} ${last.details}`
            : last.type === 'thought' ? `thought ${last.duration}`
            : last.type === 'plan' ? `${last.label}: ${last.title}`
            : last.type === 'run_command' ? `run: ${last.command.substring(0, 60)}`
            : last.type === 'todo_list' ? `todos: ${last.todosCompleted}/${last.todosTotal}`
            : 'loading';
          console.log(`  last element (${last.type}): "${preview.substring(0, 80)}..."`);
        }
      }

      this.onExtract(derivedState, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('WebSocket closed') && !message.includes('Intentional disconnect')) {
        console.warn(`[dom-extractor] Extraction failed: ${message}`);
      }
      this.handleFailure(message);
    } finally {
      this.pollInFlight = false;
      this.scheduleNextPoll();
    }
  }
}
