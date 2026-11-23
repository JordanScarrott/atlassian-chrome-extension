import { extractJiraTickets, normalizeJiraBaseUrl, sanitizeUrl } from './lib/pr-model.js';

const REVIEW_STATUS_META = {
  approved: { icon: '✓', label: 'Approved', chipClass: 'reviewer-chip--approved', pillClass: 'status-pill--approved' },
  changes_requested: { icon: '!', label: 'Changes requested', chipClass: 'reviewer-chip--changes', pillClass: 'status-pill--changes' },
  pending: { icon: '○', label: 'Needs review', chipClass: 'reviewer-chip--pending', pillClass: 'status-pill--pending' },
};

const STORAGE_RELEVANT_KEYS = new Set([
  'apiToken',
  'authType',
  'email',
  'jiraBaseUrl',
  'jiraToken',
  'jiraUser',
  'currentUser',
  'myPrs',
  'toReviewPrs',
  'pendingReviewCount',
  'lastUpdated',
  'error',
]);

const els = {
  headerUser: document.getElementById('header-user'),
  refreshBtn: document.getElementById('refresh-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  errorBanner: document.getElementById('error-banner'),
  errorBannerMessage: document.getElementById('error-banner-message'),
  checkCredentialsBtn: document.getElementById('check-credentials-btn'),
  loadingView: document.getElementById('loading-view'),
  authSection: document.getElementById('auth-section'),
  authHeading: document.getElementById('auth-heading'),
  authForm: document.getElementById('auth-form'),
  authMethodAtlassian: document.getElementById('auth-method-atlassian'),
  authMethodBearer: document.getElementById('auth-method-bearer'),
  setupBox: document.getElementById('setup-box'),
  apiTokensLink: document.getElementById('api-tokens-link'),
  emailField: document.getElementById('email-field'),
  emailInput: document.getElementById('email-input'),
  emailErrorText: document.getElementById('email-error-text'),
  tokenLabel: document.getElementById('token-label'),
  tokenHint: document.getElementById('token-hint'),
  tokenInput: document.getElementById('token-input'),
  tokenErrorText: document.getElementById('token-error-text'),
  toggleTokenVisibility: document.getElementById('toggle-token-visibility'),
  bitbucketKeyStatus: document.getElementById('bitbucket-key-status'),
  jiraKeyStatus: document.getElementById('jira-key-status'),
  jiraUrlInput: document.getElementById('jira-url-input'),
  jiraTokenInput: document.getElementById('jira-token-input'),
  toggleJiraTokenVisibility: document.getElementById('toggle-jira-token-visibility'),
  jiraClearRow: document.getElementById('jira-clear-row'),
  clearJiraBtn: document.getElementById('clear-jira-btn'),
  authFormError: document.getElementById('auth-form-error'),
  authFormErrorText: document.getElementById('auth-form-error-text'),
  submitAuthBtn: document.getElementById('submit-auth-btn'),
  cancelAuthBtn: document.getElementById('cancel-auth-btn'),
  signedInAccountActions: document.getElementById('signed-in-account-actions'),
  signOutBtn: document.getElementById('sign-out-btn'),
  dashboardSection: document.getElementById('dashboard-section'),
  tablist: document.querySelector('[role="tablist"]'),
  tabs: Array.from(document.querySelectorAll('[role="tab"]')),
  panels: Array.from(document.querySelectorAll('[role="tabpanel"]')),
  myPrsCount: document.getElementById('my-prs-count'),
  toReviewCount: document.getElementById('to-review-count'),
  myPrsList: document.getElementById('my-prs-list'),
  toReviewList: document.getElementById('to-review-list'),
  lastSynced: document.getElementById('last-synced'),
  appVersion: document.getElementById('app-version'),
  liveAnnouncer: document.getElementById('live-announcer'),
};

const state = {
  loaded: false,
  authenticated: false,
  hasApiToken: false,
  authType: 'atlassian_token',
  email: '',
  jiraBaseUrl: '',
  hasJiraToken: false,
  jiraUser: null,
  currentUser: null,
  myPrs: [],
  toReviewPrs: [],
  pendingReviewCount: 0,
  lastUpdated: null,
  error: null,
  isSettingsOpen: false,
  isRefreshing: false,
  isSubmittingAuth: false,
  activeTabId: 'tab-my-prs',
};

const editedFields = new WeakSet();
const flaggedFields = new WeakSet();
const announcedFields = new WeakSet();
let announceTimer = null;
let announcedTarget = null;
let stateLoadPromise = null;

function openExternalUrl(rawUrl) {
  const safeUrl = sanitizeUrl(rawUrl);
  if (!safeUrl) return;
  if (chrome?.tabs?.create) {
    chrome.tabs.create({ url: safeUrl });
  } else {
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
  }
}

function announcePolite(message, { debounceMs = 0, target = null } = {}) {
  clearTimeout(announceTimer);
  els.liveAnnouncer.textContent = '';
  announcedTarget = target;
  if (!message) return;

  if (debounceMs > 0) {
    announceTimer = setTimeout(() => {
      els.liveAnnouncer.textContent = message;
    }, debounceMs);
  } else {
    els.liveAnnouncer.textContent = message;
  }
}

function clearFieldAnnouncement(field) {
  if (announcedTarget === field) {
    clearTimeout(announceTimer);
    els.liveAnnouncer.textContent = '';
    announcedTarget = null;
  }
}

function getSelectedAuthType() {
  return els.authMethodBearer.checked ? 'bearer_token' : 'atlassian_token';
}

function setSelectedAuthType(authType) {
  const isBearer = authType === 'bearer_token';
  els.authMethodBearer.checked = isBearer;
  els.authMethodAtlassian.checked = !isBearer;
  updateAuthMethodFields();
}

function linkErrorInDescribedBy(input, showError) {
  const errorId = input.dataset.error;
  if (!errorId) return;
  const ids = (input.getAttribute('aria-describedby') || '')
    .split(/\s+/)
    .filter((id) => id && id !== errorId);
  if (showError) ids.push(errorId);
  if (ids.length > 0) {
    input.setAttribute('aria-describedby', ids.join(' '));
  } else {
    input.removeAttribute('aria-describedby');
  }
}

function clearFieldError(input) {
  input.setCustomValidity('');
  input.classList.remove('user-invalid-fallback');
  input.setAttribute('aria-invalid', 'false');
  linkErrorInDescribedBy(input, false);
  flaggedFields.delete(input);
  announcedFields.delete(input);
  clearFieldAnnouncement(input);
}

function getFieldErrorMessage(input) {
  if (input === els.emailInput) {
    if (!input.value.trim()) {
      return 'Enter your Atlassian account email address.';
    }
    return 'Enter an email address in the format you@example.com.';
  }
  if (input === els.tokenInput) {
    return getSelectedAuthType() === 'bearer_token'
      ? 'Enter your Bitbucket access token.'
      : 'Enter your Atlassian API token.';
  }
  return 'Please enter a valid value.';
}

function applyFieldInvalidState(input, { announce = false } = {}) {
  const msg = getFieldErrorMessage(input);
  if (input === els.emailInput) {
    els.emailErrorText.textContent = msg;
  } else if (input === els.tokenInput) {
    els.tokenErrorText.textContent = msg;
  }

  input.classList.add('user-invalid-fallback');
  input.setAttribute('aria-invalid', 'true');
  linkErrorInDescribedBy(input, true);
  flaggedFields.add(input);

  if (announce && !announcedFields.has(input)) {
    const labelText = input.labels?.[0]?.textContent?.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    const fullMsg = labelText ? `${labelText}: Error: ${msg}` : `Error: ${msg}`;
    announcePolite(fullMsg, { debounceMs: 500, target: input });
    announcedFields.add(input);
  }
}

function validateField(input, { announce = false, force = false } = {}) {
  if (input.closest('[hidden]')) {
    clearFieldError(input);
    return true;
  }

  input.setCustomValidity('');
  const trimmed = input.value.trim();

  if (!trimmed) {
    input.setCustomValidity(getFieldErrorMessage(input));
  }

  const isValid = input.validity.valid && (force ? Boolean(trimmed) : !input.matches(':user-invalid'));
  if (!isValid) {
    applyFieldInvalidState(input, { announce });
    return false;
  }

  clearFieldError(input);
  return true;
}

function updateAuthMethodFields() {
  const authType = getSelectedAuthType();
  const isAtlassian = authType === 'atlassian_token';

  els.emailField.hidden = !isAtlassian;
  els.emailInput.required = isAtlassian;
  if (!isAtlassian) {
    clearFieldError(els.emailInput);
    editedFields.delete(els.emailInput);
  }

  els.setupBox.hidden = !isAtlassian;

  if (isAtlassian) {
    els.tokenLabel.textContent = 'Atlassian API Token ';
    els.tokenHint.textContent = 'Paste your scoped token (stored locally in Chrome storage)';
    els.tokenInput.placeholder = state.authenticated ? 'Paste new API token to update' : 'Paste API token';
  } else {
    els.tokenLabel.textContent = 'Bitbucket Access Token ';
    els.tokenHint.textContent = 'Paste your Bitbucket workspace, repo, or account access token';
    els.tokenInput.placeholder = state.authenticated ? 'Paste new access token to update' : 'Paste access token';
  }
  const star = document.createElement('span');
  star.className = 'required-mark';
  star.setAttribute('aria-hidden', 'true');
  star.textContent = '*';
  els.tokenLabel.appendChild(star);

  if (flaggedFields.has(els.tokenInput)) {
    validateField(els.tokenInput, { announce: false, force: true });
  }
}

function formatRelativeTime(isoString) {
  if (!isoString) return 'Unknown';
  const timestamp = Date.parse(isoString);
  if (!Number.isFinite(timestamp)) return 'Unknown';

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return 'just now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${Math.floor(diffMonths / 12)}y ago`;
}

function formatAbsoluteTime(isoString) {
  if (!isoString) return '';
  const timestamp = Date.parse(isoString);
  if (!Number.isFinite(timestamp)) return isoString;
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function selectTab(targetTab, { scroll = true } = {}) {
  if (!targetTab) return;
  state.activeTabId = targetTab.id;

  for (const tab of els.tabs) {
    const isSelected = tab === targetTab;
    tab.setAttribute('aria-selected', String(isSelected));
    tab.setAttribute('tabindex', isSelected ? '0' : '-1');
    tab.toggleAttribute('focusgroupstart', isSelected);
  }

  for (const panel of els.panels) {
    const isMatch = panel.getAttribute('aria-labelledby') === targetTab.id;
    panel.hidden = !isMatch;
    if (isMatch) {
      panel.setAttribute('tabindex', '0');
    } else {
      panel.removeAttribute('tabindex');
    }
  }

  if (scroll) {
    targetTab.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      container: 'nearest',
    });
  }
}

function createEmptyState(title, message) {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';

  const h = document.createElement('h2');
  h.className = 'empty-state-title';
  h.textContent = title;

  const p = document.createElement('p');
  p.className = 'empty-state-text';
  p.textContent = message;

  wrapper.append(h, p);
  return wrapper;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function createSvgIcon(pathD, { viewBox = '0 0 16 16', className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', pathD);
  svg.append(path);
  return svg;
}

function getInitials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function createAvatar(user, { size = 'sm', reviewState = null, title = '' } = {}) {
  const wrap = document.createElement('span');
  wrap.className = `bb-avatar bb-avatar--${size}`;
  if (reviewState === 'approved') {
    wrap.classList.add('bb-avatar--approved');
  } else if (reviewState === 'changes_requested') {
    wrap.classList.add('bb-avatar--changes');
  } else if (reviewState === 'pending') {
    wrap.classList.add('bb-avatar--pending');
  }
  if (title) wrap.title = title;

  const displayName = user?.displayName || 'User';
  const fallback = document.createElement('span');
  fallback.className = 'bb-avatar-initials';
  fallback.textContent = getInitials(displayName);
  fallback.setAttribute('aria-hidden', 'true');

  const safeAvatarUrl = sanitizeUrl(user?.avatarUrl);
  if (safeAvatarUrl) {
    const img = document.createElement('img');
    img.className = 'bb-avatar-img';
    img.src = safeAvatarUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.remove();
    });
    wrap.append(fallback, img);
  } else {
    wrap.append(fallback);
  }

  if (reviewState === 'approved' || reviewState === 'changes_requested') {
    const badge = document.createElement('span');
    badge.className = `bb-avatar-badge bb-avatar-badge--${reviewState === 'approved' ? 'approved' : 'changes'}`;
    badge.setAttribute('aria-hidden', 'true');
    const iconPath =
      reviewState === 'approved'
        ? 'M6.5 11.2 3.3 8l1.1-1.1 2.1 2.1 5.1-5.1L12.7 5z'
        : 'M8 2a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1zm0 10a1.25 1.25 0 1 1 0-2.5A1.25 1.25 0 0 1 8 12z';
    badge.append(createSvgIcon(iconPath, { className: 'bb-avatar-badge-svg' }));
    wrap.append(badge);
  }

  return wrap;
}

function createStatusPill(reviewState) {
  const meta = REVIEW_STATUS_META[reviewState] || REVIEW_STATUS_META.pending;
  const pill = document.createElement('span');
  pill.className = `status-pill ${meta.pillClass}`;

  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = meta.icon;

  const text = document.createElement('span');
  text.textContent = meta.label;

  pill.append(icon, text);
  return pill;
}

function createReviewerStack(reviewers) {
  const container = document.createElement('div');
  container.className = 'bb-reviewer-stack';

  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    const none = document.createElement('span');
    none.className = 'pr-reviewers-empty';
    none.textContent = 'No reviewers';
    container.append(none);
    return container;
  }

  const stateLabels = {
    approved: 'Approved',
    changes_requested: 'Changes requested',
    pending: 'Pending review',
  };

  // Sort: approved first, then changes_requested, then pending
  const order = { approved: 0, changes_requested: 1, pending: 2 };
  const sorted = [...reviewers].sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2));

  const maxVisible = 5;
  const visible = sorted.slice(0, maxVisible);
  const overflow = sorted.length - visible.length;

  const avatarGroup = document.createElement('div');
  avatarGroup.className = 'bb-avatar-group';

  for (const reviewer of visible) {
    const label = `${reviewer.displayName || 'Reviewer'}${reviewer.isMe ? ' (you)' : ''} — ${stateLabels[reviewer.state] || 'Pending review'}`;
    avatarGroup.append(createAvatar(reviewer, { size: 'sm', reviewState: reviewer.state || 'pending', title: label }));
  }

  if (overflow > 0) {
    const more = document.createElement('span');
    more.className = 'bb-avatar-more';
    more.textContent = `+${overflow}`;
    more.title = sorted
      .slice(maxVisible)
      .map((r) => `${r.displayName || 'Reviewer'}: ${stateLabels[r.state] || 'Pending'}`)
      .join('\n');
    avatarGroup.append(more);
  }

  const approvedCount = reviewers.filter((r) => r.state === 'approved').length;
  const countText = document.createElement('span');
  countText.className = 'bb-approval-ratio';
  countText.textContent = `${approvedCount}/${reviewers.length}`;
  countText.title = sorted
    .map((r) => `${r.displayName || 'Reviewer'}${r.isMe ? ' (you)' : ''}: ${stateLabels[r.state] || 'Pending'}`)
    .join('\n');

  container.append(avatarGroup, countText);
  return container;
}

function createPrCard(pr, { showReviewStatus = false } = {}) {
  const card = document.createElement('article');
  card.className = 'pr-card';

  // Left: Author Avatar
  const authorName = pr.author?.displayName || 'Unknown Author';
  const authorAvatar = createAvatar(
    { displayName: authorName, avatarUrl: pr.author?.avatarUrl },
    { size: 'md', title: `Author: ${authorName}` }
  );
  card.append(authorAvatar);

  // Right: Main 4-row content column
  const mainCol = document.createElement('div');
  mainCol.className = 'pr-card-main';

  // Row 1: repo + PR number + review status pill + updated time
  const topRow = document.createElement('div');
  topRow.className = 'pr-card-top';

  const repoGroup = document.createElement('div');
  repoGroup.className = 'pr-repo-group';

  const repoSpan = document.createElement('span');
  repoSpan.className = 'pr-repo';
  repoSpan.textContent = pr.repoName || 'Repository';
  if (pr.repoFullName) {
    repoSpan.title = pr.repoFullName;
  }

  const numSpan = document.createElement('span');
  numSpan.className = 'pr-number';
  numSpan.textContent = `#${pr.id ?? ''}`;

  repoGroup.append(repoSpan, numSpan);

  const jiraTickets = extractJiraTickets(
    {
      sourceBranch: pr.sourceBranch || '',
      title: pr.title || '',
      description: pr.description || '',
    },
    state.jiraBaseUrl
  );
  if (jiraTickets.length > 0) {
    const primary = jiraTickets[0];
    if (primary.url) {
      const jiraLink = document.createElement('a');
      jiraLink.className = 'jira-ticket-badge';
      jiraLink.href = primary.url;
      jiraLink.target = '_blank';
      jiraLink.rel = 'noopener noreferrer';
      jiraLink.title = `Open ${primary.key} in Jira${jiraTickets.length > 1 ? ` (+${jiraTickets.length - 1} more)` : ''}`;
      jiraLink.append(
        createSvgIcon(
          'M11.53 2H7.65a3.32 3.32 0 0 0 3.32 3.32h1.35v1.3A3.32 3.32 0 0 0 15.65 10V6.12A4.12 4.12 0 0 0 11.53 2zM7.65 5.88H3.77a3.32 3.32 0 0 0 3.32 3.32h1.35v1.31a3.32 3.32 0 0 0 3.33 3.32V10a4.12 4.12 0 0 0-4.12-4.12z',
          { viewBox: '0 0 16 16', className: 'jira-badge-svg' }
        ),
        document.createTextNode(primary.key)
      );
      jiraLink.addEventListener('click', (event) => {
        event.preventDefault();
        openExternalUrl(primary.url);
      });
      repoGroup.append(jiraLink);
    } else {
      const jiraBtn = document.createElement('button');
      jiraBtn.type = 'button';
      jiraBtn.className = 'jira-ticket-badge jira-ticket-badge--unlinked';
      jiraBtn.title = `Set Jira Site URL in Settings to link ${primary.key}`;
      jiraBtn.textContent = primary.key;
      jiraBtn.addEventListener('click', () => {
        openSettings({ focusJira: true });
      });
      repoGroup.append(jiraBtn);
    }
  }

  const topRight = document.createElement('div');
  topRight.className = 'pr-top-right';

  if (showReviewStatus && pr.myReviewState && pr.myReviewState !== 'none') {
    topRight.append(createStatusPill(pr.myReviewState));
  }

  const updatedTime = document.createElement('time');
  updatedTime.className = 'pr-updated';
  if (pr.updatedOn) {
    updatedTime.dateTime = pr.updatedOn;
    updatedTime.title = formatAbsoluteTime(pr.updatedOn);
  }
  updatedTime.textContent = formatRelativeTime(pr.updatedOn);
  topRight.append(updatedTime);

  topRow.append(repoGroup, topRight);
  mainCol.append(topRow);

  // Row 2: Single-line Title
  const titleHeading = document.createElement('h3');
  titleHeading.className = 'pr-title-row';
  const titleText = pr.title || 'Untitled Pull Request';

  const safePrUrl = sanitizeUrl(pr.url);
  if (safePrUrl) {
    const link = document.createElement('a');
    link.className = 'pr-title-link';
    link.href = safePrUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = titleText;
    link.title = titleText;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openExternalUrl(safePrUrl);
    });
    titleHeading.append(link);
  } else {
    const titleSpan = document.createElement('span');
    titleSpan.className = 'pr-title-text';
    titleSpan.textContent = titleText;
    titleSpan.title = titleText;
    titleHeading.append(titleSpan);
  }

  mainCol.append(titleHeading);

  // Row 3: Single-line Description
  const rawDescription = typeof pr.description === 'string' ? pr.description.replace(/\s+/g, ' ').trim() : '';
  const descEl = document.createElement('p');
  descEl.className = rawDescription ? 'pr-desc-line' : 'pr-desc-line pr-desc-empty';
  descEl.textContent = rawDescription || 'No description';
  if (rawDescription) {
    descEl.title = pr.description.trim();
  }
  mainCol.append(descEl);

  // Row 4: Compact Footer (Bitbucket Reviewer Avatars + Comment/Task SVG counts)
  const metaFooter = document.createElement('div');
  metaFooter.className = 'pr-card-footer';

  metaFooter.append(createReviewerStack(pr.reviewers));

  const countsGroup = document.createElement('div');
  countsGroup.className = 'pr-counts-group';

  const commentCount = Number(pr.commentCount) || 0;
  const commentItem = document.createElement('span');
  commentItem.className = 'pr-meta-item';
  commentItem.title = `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}`;
  commentItem.append(
    createSvgIcon(
      'M2.5 3A1.5 1.5 0 0 0 1 4.5v6A1.5 1.5 0 0 0 2.5 12H5v2.25a.5.5 0 0 0 .82.38L9.05 12h4.45A1.5 1.5 0 0 0 15 10.5v-6A1.5 1.5 0 0 0 13.5 3h-11zm0 1.5h11v6H8.55a.5.5 0 0 0-.32.12L6.5 12.06V11a.5.5 0 0 0-.5-.5H2.5v-6z',
      { className: 'pr-meta-svg' }
    ),
    document.createTextNode(String(commentCount))
  );
  countsGroup.append(commentItem);

  const taskCount = Number(pr.taskCount) || 0;
  if (taskCount > 0) {
    const taskItem = document.createElement('span');
    taskItem.className = 'pr-meta-item';
    taskItem.title = `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
    taskItem.append(
      createSvgIcon(
        'M3 2.5A1.5 1.5 0 0 0 1.5 4v8A1.5 1.5 0 0 0 3 13.5h10a1.5 1.5 0 0 0 1.5-1.5V4A1.5 1.5 0 0 0 13 2.5H3zm8.28 4.28-4 4a.75.75 0 0 1-1.06 0l-1.5-1.5a.75.75 0 1 1 1.06-1.06l.97.97 3.47-3.47a.75.75 0 1 1 1.06 1.06z',
        { className: 'pr-meta-svg' }
      ),
      document.createTextNode(String(taskCount))
    );
    countsGroup.append(taskItem);
  }

  metaFooter.append(countsGroup);
  mainCol.append(metaFooter);
  card.append(mainCol);
  return card;
}

function renderPrList(container, prs, emptyTitle, emptyMessage, options) {
  container.replaceChildren();
  if (!Array.isArray(prs) || prs.length === 0) {
    container.append(createEmptyState(emptyTitle, emptyMessage));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const pr of prs) {
    fragment.append(createPrCard(pr, options));
  }
  container.append(fragment);
}

function renderErrorBanner() {
  const err = state.error;
  if (!state.authenticated || !err || !err.message || state.isSettingsOpen) {
    els.errorBanner.hidden = true;
    els.checkCredentialsBtn.hidden = true;
    return;
  }

  els.errorBannerMessage.textContent = err.message;
  const isCredentialIssue = err.code === 'AUTH_FAILED' || err.code === 'MISSING_SCOPE';
  els.checkCredentialsBtn.hidden = !isCredentialIssue;
  els.errorBanner.hidden = false;
}

function renderAuthFormChrome() {
  const isAuth = state.authenticated;
  els.authHeading.textContent = isAuth ? 'API Keys & Integrations' : 'Connect Bitbucket & Jira';
  els.submitAuthBtn.textContent = state.isSubmittingAuth
    ? 'Syncing…'
    : isAuth
      ? 'Save & Sync'
      : 'Sign In & Sync';
  els.submitAuthBtn.disabled = state.isSubmittingAuth;
  els.cancelAuthBtn.hidden = !isAuth;
  els.signedInAccountActions.hidden = !isAuth;
  els.signOutBtn.disabled = state.isSubmittingAuth;

  // Bitbucket key status badge & optional token update
  els.tokenInput.required = !(isAuth && state.hasApiToken);
  els.tokenInput.placeholder =
    isAuth && state.hasApiToken ? 'Saved (leave blank to keep)' : 'Paste API token';

  if (els.bitbucketKeyStatus) {
    els.bitbucketKeyStatus.textContent = isAuth ? 'Connected' : 'Not connected';
    els.bitbucketKeyStatus.classList.toggle('integration-badge--ok', isAuth);
  }

  // Jira key/URL status badge
  els.jiraTokenInput.placeholder = state.hasJiraToken
    ? 'Saved (leave blank to keep)'
    : 'Optional Jira API token';

  if (els.jiraKeyStatus) {
    if (state.hasJiraToken && state.jiraBaseUrl) {
      els.jiraKeyStatus.textContent = state.jiraUser?.displayName
        ? `Verified (${state.jiraUser.displayName})`
        : 'Verified';
      els.jiraKeyStatus.classList.add('integration-badge--ok');
    } else if (state.jiraBaseUrl) {
      els.jiraKeyStatus.textContent = 'URL Linked';
      els.jiraKeyStatus.classList.add('integration-badge--ok');
    } else {
      els.jiraKeyStatus.textContent = 'Not configured';
      els.jiraKeyStatus.classList.remove('integration-badge--ok');
    }
  }

  if (els.jiraClearRow) {
    els.jiraClearRow.hidden = !(state.jiraBaseUrl || state.hasJiraToken);
  }
}

function renderUI() {
  els.loadingView.hidden = state.loaded;
  if (!state.loaded) {
    els.authSection.hidden = true;
    els.dashboardSection.hidden = true;
    return;
  }

  const showAuth = !state.authenticated || state.isSettingsOpen;

  // Header user label & action buttons
  if (state.authenticated && state.currentUser) {
    const label = state.currentUser.displayName || state.currentUser.username || state.email;
    els.headerUser.replaceChildren();
    if (label) {
      els.headerUser.append(
        createAvatar(
          { displayName: label, avatarUrl: state.currentUser.avatarUrl },
          { size: 'xs' }
        ),
        document.createTextNode(label)
      );
      els.headerUser.hidden = false;
    } else {
      els.headerUser.hidden = true;
    }
  } else {
    els.headerUser.replaceChildren();
    els.headerUser.hidden = true;
  }

  els.refreshBtn.hidden = !state.authenticated;
  els.refreshBtn.disabled = state.isRefreshing || !state.authenticated;
  els.refreshBtn.classList.toggle('is-spinning', state.isRefreshing);
  els.refreshBtn.setAttribute('aria-busy', String(state.isRefreshing));

  els.settingsBtn.hidden = !state.authenticated;
  els.settingsBtn.setAttribute('aria-expanded', String(state.isSettingsOpen));

  renderErrorBanner();

  els.authSection.hidden = !showAuth;
  els.dashboardSection.hidden = showAuth;

  if (showAuth) {
    renderAuthFormChrome();
  } else {
    els.myPrsCount.textContent = String(state.myPrs.length);
    els.toReviewCount.textContent = String(state.toReviewPrs.length);

    renderPrList(
      els.myPrsList,
      state.myPrs,
      'No open pull requests',
      'Pull requests you author across your Bitbucket workspaces will appear here.',
      { showReviewStatus: false }
    );

    renderPrList(
      els.toReviewList,
      state.toReviewPrs,
      "You're all caught up!",
      'No open pull requests currently need your review.',
      { showReviewStatus: true }
    );

    const activeTab = els.tabs.find((t) => t.id === state.activeTabId) || els.tabs[0];
    selectTab(activeTab, { scroll: false });
  }

  // Footer
  if (state.lastUpdated) {
    const rel = formatRelativeTime(state.lastUpdated);
    els.lastSynced.textContent = `Last synced: ${rel}`;
    els.lastSynced.title = formatAbsoluteTime(state.lastUpdated);
  } else {
    els.lastSynced.textContent = 'Last synced: Never';
    els.lastSynced.removeAttribute('title');
  }
}

function hydrateAuthFormFromState() {
  setSelectedAuthType(state.authType || 'atlassian_token');
  els.emailInput.value = state.email || '';
  els.tokenInput.value = '';
  els.jiraUrlInput.value = state.jiraBaseUrl || '';
  els.jiraTokenInput.value = '';
  els.authFormError.hidden = true;
  els.authFormErrorText.textContent = '';

  clearFieldError(els.emailInput);
  clearFieldError(els.tokenInput);
  clearFieldError(els.jiraUrlInput);
  editedFields.delete(els.emailInput);
  editedFields.delete(els.tokenInput);
  editedFields.delete(els.jiraUrlInput);
}

function openSettings({ focusCredentials = false, focusJira = false } = {}) {
  state.isSettingsOpen = true;
  hydrateAuthFormFromState();
  renderUI();

  if (focusJira) {
    els.jiraUrlInput.focus();
  } else if (focusCredentials) {
    if (getSelectedAuthType() === 'atlassian_token' && !els.emailInput.value.trim()) {
      els.emailInput.focus();
    } else {
      els.tokenInput.focus();
    }
  }
}

function closeSettings() {
  state.isSettingsOpen = false;
  els.authFormError.hidden = true;
  renderUI();
}

async function loadState({ syncFormInputs = false } = {}) {
  if (stateLoadPromise) return stateLoadPromise;

  stateLoadPromise = (async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (response?.ok) {
        const wasAuthenticated = state.authenticated;
        state.authenticated = Boolean(response.authenticated);
        state.hasApiToken = Boolean(response.hasApiToken ?? response.authenticated);
        state.authType = response.authType || 'atlassian_token';
        state.email = response.email || '';
        state.jiraBaseUrl = response.jiraBaseUrl || '';
        state.hasJiraToken = Boolean(response.hasJiraToken);
        state.jiraUser = response.jiraUser || null;
        state.currentUser = response.currentUser || null;
        state.myPrs = Array.isArray(response.myPrs) ? response.myPrs : [];
        state.toReviewPrs = Array.isArray(response.toReviewPrs) ? response.toReviewPrs : [];
        state.pendingReviewCount = Number(response.pendingReviewCount) || 0;
        state.lastUpdated = response.lastUpdated || null;
        state.error = response.error || null;

        if (!state.authenticated) {
          state.isSettingsOpen = false;
        }

        if (syncFormInputs || (!wasAuthenticated && !state.authenticated)) {
          hydrateAuthFormFromState();
        }
      }
    } catch (err) {
      state.error = {
        code: 'RUNTIME_ERROR',
        message: err?.message || 'Unable to communicate with extension background worker.',
      };
    } finally {
      state.loaded = true;
      stateLoadPromise = null;
      renderUI();
    }
  })();

  return stateLoadPromise;
}

const AUTO_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;

async function handleRefresh({ auto = false } = {}) {
  if (state.isRefreshing || !state.authenticated) return;

  if (auto && state.lastUpdated) {
    const lastTs = Date.parse(state.lastUpdated);
    if (Number.isFinite(lastTs) && Date.now() - lastTs < AUTO_REFRESH_COOLDOWN_MS) {
      return;
    }
  }

  state.isRefreshing = true;
  renderUI();

  try {
    const response = await chrome.runtime.sendMessage({ type: 'REFRESH_PRS', auto });
    if (response?.skipped) {
      return;
    }
    await loadState();
    if (response?.ok) {
      announcePolite('Pull requests refreshed.');
    } else if (response?.error?.message) {
      announcePolite(`Refresh failed: ${response.error.message}`);
    }
  } catch (err) {
    announcePolite(`Refresh failed: ${err?.message || 'Unexpected error'}`);
  } finally {
    state.isRefreshing = false;
    renderUI();
  }
}

async function handleSignOut() {
  if (state.isSubmittingAuth) return;
  state.isSubmittingAuth = true;
  renderAuthFormChrome();

  try {
    await chrome.runtime.sendMessage({ type: 'SIGN_OUT' });
    state.isSettingsOpen = false;
    await loadState({ syncFormInputs: true });
    announcePolite('Signed out of Bitbucket.');
  } catch (err) {
    els.authFormErrorText.textContent = err?.message || 'Failed to sign out.';
    els.authFormError.hidden = false;
    announcePolite(`Error: ${els.authFormErrorText.textContent}`);
  } finally {
    state.isSubmittingAuth = false;
    renderUI();
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (state.isSubmittingAuth) return;

  els.authFormError.hidden = true;
  els.authFormErrorText.textContent = '';

  const authType = getSelectedAuthType();
  const fieldsToValidate = [];
  if (authType === 'atlassian_token') {
    fieldsToValidate.push(els.emailInput);
  }
  if (!(state.authenticated && state.hasApiToken)) {
    fieldsToValidate.push(els.tokenInput);
  }

  const rawJiraUrl = els.jiraUrlInput.value.trim();
  if (rawJiraUrl && !normalizeJiraBaseUrl(rawJiraUrl)) {
    els.jiraUrlInput.setCustomValidity('Enter a valid URL (e.g. https://your-company.atlassian.net).');
    fieldsToValidate.push(els.jiraUrlInput);
  } else {
    els.jiraUrlInput.setCustomValidity('');
  }

  const invalidFields = [];
  for (const field of fieldsToValidate) {
    editedFields.add(field);
    announcedFields.add(field); // Focus moving to first invalid field announces its error
    const valid = validateField(field, { announce: false, force: true });
    if (!valid) {
      invalidFields.push(field);
    }
  }

  if (invalidFields.length > 0) {
    invalidFields[0].focus();
    return;
  }

  state.isSubmittingAuth = true;
  renderAuthFormChrome();

  try {
    const payload = {
      type: 'SIGN_IN_AND_SYNC',
      credentials: {
        authType,
        email: authType === 'atlassian_token' ? els.emailInput.value.trim() : '',
        apiToken: els.tokenInput.value.trim(),
        jiraBaseUrl: rawJiraUrl ? normalizeJiraBaseUrl(rawJiraUrl) : '',
        jiraToken: els.jiraTokenInput.value.trim(),
      },
    };

    const response = await chrome.runtime.sendMessage(payload);
    if (response?.ok) {
      state.isSettingsOpen = false;
      els.tokenInput.value = '';
      els.jiraTokenInput.value = '';
      clearFieldError(els.emailInput);
      clearFieldError(els.tokenInput);
      clearFieldError(els.jiraUrlInput);
      await loadState({ syncFormInputs: true });
      announcePolite('Settings saved and pull requests synced.');
    } else {
      const msg = response?.error?.message || 'Sign in failed. Check your credentials and scopes.';
      els.authFormErrorText.textContent = msg;
      els.authFormError.hidden = false;
      announcePolite(`Error: ${msg}`);
    }
  } catch (err) {
    const msg = err?.message || 'Unexpected error during sign in.';
    els.authFormErrorText.textContent = msg;
    els.authFormError.hidden = false;
    announcePolite(`Error: ${msg}`);
  } finally {
    state.isSubmittingAuth = false;
    renderUI();
  }
}

function bindEvents() {
  // Version display
  const manifestVersion = chrome?.runtime?.getManifest?.()?.version;
  if (manifestVersion) {
    els.appVersion.textContent = `v${manifestVersion}`;
  }

  // External link in setup box
  els.apiTokensLink.addEventListener('click', (event) => {
    event.preventDefault();
    openExternalUrl(els.apiTokensLink.href);
  });

  // Header actions
  els.refreshBtn.addEventListener('click', () => handleRefresh({ auto: false }));
  els.settingsBtn.addEventListener('click', () => {
    if (state.isSettingsOpen) {
      closeSettings();
    } else {
      openSettings();
    }
  });

  els.checkCredentialsBtn.addEventListener('click', () => {
    openSettings({ focusCredentials: true });
  });

  // Auth method selector
  els.authMethodAtlassian.addEventListener('change', updateAuthMethodFields);
  els.authMethodBearer.addEventListener('change', updateAuthMethodFields);

  // Token show/hide toggles
  els.toggleTokenVisibility.addEventListener('click', () => {
    const isVisible = els.tokenInput.type === 'text';
    els.tokenInput.type = isVisible ? 'password' : 'text';
    const nextPressed = !isVisible;
    els.toggleTokenVisibility.setAttribute('aria-pressed', String(nextPressed));
    const label = nextPressed ? 'Hide token' : 'Show token';
    els.toggleTokenVisibility.setAttribute('aria-label', label);
    els.toggleTokenVisibility.title = label;
  });

  els.toggleJiraTokenVisibility.addEventListener('click', () => {
    const isVisible = els.jiraTokenInput.type === 'text';
    els.jiraTokenInput.type = isVisible ? 'password' : 'text';
    const nextPressed = !isVisible;
    els.toggleJiraTokenVisibility.setAttribute('aria-pressed', String(nextPressed));
    const label = nextPressed ? 'Hide Jira token' : 'Show Jira token';
    els.toggleJiraTokenVisibility.setAttribute('aria-label', label);
    els.toggleJiraTokenVisibility.title = label;
  });

  els.clearJiraBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_JIRA' });
    els.jiraUrlInput.value = '';
    els.jiraTokenInput.value = '';
    await loadState({ syncFormInputs: true });
    announcePolite('Jira integration removed.');
  });

  // Form validation lifecycle: blur (if edited), clear on input when fixed, validate all on submit
  els.authForm.addEventListener(
    'blur',
    (event) => {
      const target = event.target;
      if (target !== els.emailInput && target !== els.tokenInput) return;
      if (!editedFields.has(target)) return;
      validateField(target, { announce: true, force: true });
    },
    true
  );

  els.authForm.addEventListener('input', (event) => {
    const target = event.target;
    if (target !== els.emailInput && target !== els.tokenInput) return;
    editedFields.add(target);
    target.setCustomValidity('');

    const wasInvalid =
      target.getAttribute('aria-invalid') === 'true' ||
      flaggedFields.has(target) ||
      target.matches(':user-invalid');

    if (wasInvalid) {
      const trimmed = target.value.trim();
      if (trimmed && target.validity.valid) {
        clearFieldError(target);
      }
    }
  });

  els.authForm.addEventListener('submit', handleAuthSubmit);
  els.cancelAuthBtn.addEventListener('click', closeSettings);
  els.signOutBtn.addEventListener('click', handleSignOut);

  // Tabs: selection follows focus + click + ArrowLeft/ArrowRight/Home/End fallback
  els.tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && els.tabs.includes(tab)) {
      selectTab(tab);
    }
  });

  els.tablist.addEventListener('focusin', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && els.tabs.includes(tab) && tab.id !== state.activeTabId) {
      selectTab(tab);
    }
  });

  els.tablist.addEventListener('keydown', (event) => {
    const currentTab = event.target.closest('[role="tab"]');
    if (!currentTab) return;

    const currentIndex = els.tabs.indexOf(currentTab);
    if (currentIndex === -1) return;

    let nextIndex = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % els.tabs.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + els.tabs.length) % els.tabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = els.tabs.length - 1;
    }

    if (nextIndex === null) return;

    event.preventDefault();
    const targetTab = els.tabs[nextIndex];
    targetTab.focus();
    selectTab(targetTab);
  });

  // Live sync when background alarm or worker updates storage
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const hasRelevantChange = Object.keys(changes).some((key) => STORAGE_RELEVANT_KEYS.has(key));
    if (hasRelevantChange) {
      loadState();
    }
  });
}

bindEvents();
(async () => {
  await loadState({ syncFormInputs: true });
  if (state.authenticated) {
    handleRefresh({ auto: true });
  }
})();
