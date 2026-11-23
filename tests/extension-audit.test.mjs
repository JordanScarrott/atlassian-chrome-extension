import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT_DIR, 'bitbucket-pr-extension');

test('DOM IDs, CSS selectors, classes, CSP, and MV3 runtime invariants stay consistent', async () => {
  const [popupHtml, popupJs, stylesCss, backgroundJs] = await Promise.all([
    fs.readFile(path.join(EXT_DIR, 'popup.html'), 'utf8'),
    fs.readFile(path.join(EXT_DIR, 'popup.js'), 'utf8'),
    fs.readFile(path.join(EXT_DIR, 'styles.css'), 'utf8'),
    fs.readFile(path.join(EXT_DIR, 'background.js'), 'utf8')
  ]);

  // 1. Collect all HTML IDs from popup.html
  const htmlIds = new Set(Array.from(popupHtml.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));

  // Every getEl('id', ...) call in popup.js must reference an existing element ID in popup.html
  const getElIds = Array.from(popupJs.matchAll(/getEl\(\s*'([^']+)'/g), (m) => m[1]);
  assert.ok(getElIds.length > 0);
  for (const id of getElIds) {
    assert.ok(htmlIds.has(id), `popup.js references missing HTML id="#${id}"`);
  }

  // Every .className / classList CSS selector toggled in popup.js must exist in styles.css
  const referencedClasses = [
    'hidden',
    'active',
    'is-your-turn',
    'is-selected',
    'is-spinning',
    'compact-mode',
    'state-needs_review',
    'state-changes_requested',
    'state-ci_failed',
    'state-ready_to_merge',
    'state-waiting_reviewers',
    'state-approved_by_you',
    'state-changes_requested_by_you',
    'state-draft',
    'ci-badge',
    'ci-successful',
    'ci-failed',
    'ci-inprogress',
    'ci-stopped',
    'meta-task-badge',
    'meta-cr-badge',
    'snooze-remaining-badge',
    'toast-action-btn',
    'jira-ticket-actions',
    'toast-success',
    'toast-error',
    'inline-banner',
    'status-chip',
    'status-chip-neutral',
    'status-chip-error',
    'status-chip-warning',
    'status-chip-connected'
  ];
  for (const cls of referencedClasses) {
    assert.ok(stylesCss.includes(`.${cls}`), `styles.css is missing selector .${cls}`);
  }
  assert.ok(stylesCss.includes('@media (prefers-color-scheme: dark)'));

  // 2. CSP & Security: no inline event handlers in popup.html, no runtime innerHTML/eval in popup.js
  assert.equal(/\son[a-z]+\s*=/i.test(popupHtml), false);
  const strippedPopupJs = popupJs.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b/.test(strippedPopupJs), false);

  // 3. MV3 runtime messaging safety
  assert.ok(popupJs.includes('chrome.runtime.lastError'));
  assert.ok(popupJs.includes('SYNCED_WORKSPACES'));
  assert.ok(backgroundJs.includes('chrome.runtime.onMessage.addListener'));
  assert.ok(backgroundJs.includes('return true;'));
});
