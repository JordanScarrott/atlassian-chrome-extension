import { fetchOpenPullRequests } from './lib/bitbucket.js';
import { verifyJiraCredentials } from './lib/jira.js';
import { normalizeJiraBaseUrl } from './lib/pr-model.js';

const ALARM_NAME = 'pollPRs';
const ALARM_INTERVAL_MINS = 60;
const MIN_AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15-minute cooldown for automatic on-open refreshes

let activeSyncPromise = null;

const CREDENTIAL_KEYS = ['authType', 'email', 'apiToken', 'jiraBaseUrl', 'jiraToken', 'jiraUser'];
const STATE_KEYS = [
  'currentUser',
  'prList',
  'myPrs',
  'toReviewPrs',
  'pendingReviewCount',
  'workspaceCount',
  'lastUpdated',
  'lastSyncAttemptAt',
  'error',
];

async function ensurePollAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== ALARM_INTERVAL_MINS) {
    if (existing) {
      await chrome.alarms.clear(ALARM_NAME);
    }
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_INTERVAL_MINS });
  }
}

async function updateBadge({ pendingReviewCount = 0, myPrs = [] }) {
  if (pendingReviewCount > 0) {
    await chrome.action.setBadgeText({ text: String(pendingReviewCount) });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
  } else if (myPrs.length > 0) {
    await chrome.action.setBadgeText({ text: String(myPrs.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#0052CC' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function clearBadge() {
  await chrome.action.setBadgeText({ text: '' });
}

async function setErrorBadge() {
  await chrome.action.setBadgeText({ text: 'ERR' });
  await chrome.action.setBadgeBackgroundColor({ color: '#DE350B' });
}

async function syncPullRequests(overrideCredentials) {
  if (!overrideCredentials && activeSyncPromise) {
    return activeSyncPromise;
  }

  const runSync = async () => {
    const credentials = overrideCredentials
      ? {
          authType: overrideCredentials.authType || 'atlassian_token',
          email: (overrideCredentials.email || '').trim(),
          token: (overrideCredentials.apiToken ?? overrideCredentials.token ?? '').trim(),
        }
      : await (async () => {
          const stored = await chrome.storage.local.get(CREDENTIAL_KEYS);
          return {
            authType: stored.authType || 'atlassian_token',
            email: (stored.email || '').trim(),
            token: (stored.apiToken || '').trim(),
          };
        })();

    if (!credentials.token) {
      await clearBadge();
      return { ok: false, unauthenticated: true };
    }

    await chrome.storage.local.set({ lastSyncAttemptAt: Date.now() });

    try {
      const data = await fetchOpenPullRequests(credentials);

      await chrome.storage.local.set({
        currentUser: data.user,
        prList: data.prs,
        myPrs: data.myPrs,
        toReviewPrs: data.toReviewPrs,
        pendingReviewCount: data.pendingReviewCount,
        workspaceCount: data.workspaceCount,
        lastUpdated: data.lastUpdated,
        error: null,
      });

      await updateBadge(data);
      return { ok: true, data };
    } catch (err) {
      const error = {
        code: err?.code || 'API_ERROR',
        message: err?.message || 'An unknown error occurred during sync.',
      };
      await chrome.storage.local.set({ error });
      await setErrorBadge();
      return { ok: false, error };
    }
  };

  if (overrideCredentials) {
    return runSync();
  }

  activeSyncPromise = runSync();
  try {
    return await activeSyncPromise;
  } finally {
    activeSyncPromise = null;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await ensurePollAlarm();
    await syncPullRequests();
  } catch (err) {
    console.error('onInstalled sync failed:', err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await ensurePollAlarm();
    await syncPullRequests();
  } catch (err) {
    console.error('onStartup sync failed:', err);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    try {
      await syncPullRequests();
    } catch (err) {
      console.error('Alarm sync failed:', err);
    }
  }
});

async function handleMessage(message, sendResponse) {
  try {
    switch (message?.type) {
      case 'SIGN_IN_AND_SYNC': {
        const stored = await chrome.storage.local.get(CREDENTIAL_KEYS);
        const payload = message.credentials || message;
        const authType = payload?.authType || stored.authType || 'atlassian_token';
        const email = (payload?.email ?? stored.email ?? '').trim();
        const submittedApiToken = (payload?.apiToken ?? payload?.token ?? '').trim();
        const apiToken = submittedApiToken || stored.apiToken || '';
        const rawJiraUrl = (payload?.jiraBaseUrl ?? stored.jiraBaseUrl ?? '').trim();
        const jiraBaseUrl = rawJiraUrl ? normalizeJiraBaseUrl(rawJiraUrl) : '';
        const submittedJiraToken = (payload?.jiraToken ?? '').trim();
        const jiraToken = submittedJiraToken || (jiraBaseUrl ? stored.jiraToken || '' : '');

        if (rawJiraUrl && !jiraBaseUrl) {
          sendResponse({
            ok: false,
            error: {
              code: 'INVALID_INPUT',
              message: 'Jira Site URL must be a valid URL (e.g. https://your-company.atlassian.net).',
            },
          });
          break;
        }

        let jiraUser = null;
        if (jiraToken) {
          if (!jiraBaseUrl) {
            sendResponse({
              ok: false,
              error: {
                code: 'INVALID_INPUT',
                message: 'Enter your Jira Site URL to verify your Jira API token.',
              },
            });
            break;
          }
          jiraUser = await verifyJiraCredentials({ jiraBaseUrl, email, jiraToken });
        }

        const result = await syncPullRequests({ authType, email, token: apiToken });
        if (result.ok) {
          await chrome.storage.local.set({
            authType,
            email,
            apiToken,
            jiraBaseUrl,
            jiraToken,
            jiraUser,
          });
          await ensurePollAlarm();
          sendResponse({ ok: true, data: result.data, jiraBaseUrl, jiraUser });
        } else {
          sendResponse({
            ok: false,
            error: result.error || {
              code: 'INVALID_INPUT',
              message: 'API token is required.',
            },
          });
        }
        break;
      }

      case 'CLEAR_JIRA': {
        await chrome.storage.local.remove(['jiraBaseUrl', 'jiraToken', 'jiraUser']);
        sendResponse({ ok: true });
        break;
      }

      case 'REFRESH_PRS': {
        if (message?.auto) {
          const { lastUpdated, lastSyncAttemptAt } = await chrome.storage.local.get([
            'lastUpdated',
            'lastSyncAttemptAt',
          ]);
          const updatedTs = lastUpdated ? Date.parse(lastUpdated) : 0;
          const attemptTs = Number(lastSyncAttemptAt) || 0;
          const latestTs = Math.max(Number.isFinite(updatedTs) ? updatedTs : 0, attemptTs);

          if (latestTs > 0 && Date.now() - latestTs < MIN_AUTO_SYNC_INTERVAL_MS) {
            sendResponse({ ok: true, skipped: true, reason: 'cooldown' });
            break;
          }
        }
        const result = await syncPullRequests();
        sendResponse(result);
        break;
      }

      case 'SIGN_OUT': {
        await chrome.storage.local.remove([...CREDENTIAL_KEYS, ...STATE_KEYS]);
        await clearBadge();
        sendResponse({ ok: true });
        break;
      }

      case 'GET_STATE': {
        const stored = await chrome.storage.local.get([...CREDENTIAL_KEYS, ...STATE_KEYS]);
        sendResponse({
          ok: true,
          authenticated: Boolean(stored.apiToken),
          authType: stored.authType || 'atlassian_token',
          email: stored.email || '',
          hasApiToken: Boolean(stored.apiToken),
          jiraBaseUrl: stored.jiraBaseUrl || '',
          hasJiraToken: Boolean(stored.jiraToken),
          jiraUser: stored.jiraUser || null,
          currentUser: stored.currentUser || null,
          prList: stored.prList || [],
          myPrs: stored.myPrs || [],
          toReviewPrs: stored.toReviewPrs || [],
          pendingReviewCount: stored.pendingReviewCount || 0,
          workspaceCount: stored.workspaceCount || 0,
          lastUpdated: stored.lastUpdated || null,
          error: stored.error || null,
        });
        break;
      }

      default:
        sendResponse({
          ok: false,
          error: {
            code: 'UNKNOWN_MESSAGE',
            message: `Unsupported message type: ${message?.type}`,
          },
        });
    }
  } catch (err) {
    sendResponse({
      ok: false,
      error: {
        code: err?.code || 'API_ERROR',
        message: err?.message || 'Unexpected service worker error.',
      },
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message, sendResponse);
  return true;
});
