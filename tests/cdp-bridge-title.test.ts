import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCursorAgentsWindowTitle, parseCdpTitle } from '../src/server/cdp-bridge.js';

describe('isCursorAgentsWindowTitle', () => {
  it('detects the global Cursor Agents window title', () => {
    assert.equal(isCursorAgentsWindowTitle('Cursor Agents'), true);
    assert.equal(isCursorAgentsWindowTitle('Cursor Agents - Cursor'), true);
    assert.equal(isCursorAgentsWindowTitle('  cursor agents  '), true);
  });

  it('does not flag real workspace window titles', () => {
    assert.equal(isCursorAgentsWindowTitle('Customize - FactoryTycoonGame - Cursor'), false);
    assert.equal(isCursorAgentsWindowTitle('FactoryTycoonGame'), false);
    assert.equal(isCursorAgentsWindowTitle('CursorRemote'), false);
    assert.equal(isCursorAgentsWindowTitle(''), false);
    assert.equal(isCursorAgentsWindowTitle(null), false);
    assert.equal(isCursorAgentsWindowTitle(undefined), false);
  });
});

describe('parseCdpTitle', () => {
  it('extracts the workspace folder from a Cursor window title', () => {
    assert.equal(parseCdpTitle('Customize - FactoryTycoonGame - Cursor'), 'FactoryTycoonGame');
    assert.equal(parseCdpTitle('FactoryTycoonGame - Cursor'), 'FactoryTycoonGame');
  });
});
