import { BitbucketApiError, buildAuthHeaders } from './bitbucket.js';
import { normalizeJiraBaseUrl } from './pr-model.js';

/**
 * Verifies optional Jira Cloud credentials via GET /rest/api/3/myself.
 */
export async function verifyJiraCredentials(
  { jiraBaseUrl, email, jiraToken },
  fetchFn = fetch
) {
  const baseUrl = normalizeJiraBaseUrl(jiraBaseUrl);
  if (!baseUrl) {
    throw new BitbucketApiError(
      'INVALID_INPUT',
      0,
      'Enter a valid Jira Site URL (for example, https://your-company.atlassian.net).'
    );
  }

  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  const trimmedToken = typeof jiraToken === 'string' ? jiraToken.trim() : '';
  if (!trimmedEmail || !trimmedToken) {
    throw new BitbucketApiError(
      'INVALID_INPUT',
      0,
      'Both Atlassian account email and Jira API token are required to verify Jira.'
    );
  }

  const headers = buildAuthHeaders({
    authType: 'atlassian_token',
    email: trimmedEmail,
    token: trimmedToken,
  });

  let res;
  try {
    res = await fetchFn(`${baseUrl}/rest/api/3/myself`, { headers });
  } catch (err) {
    throw new BitbucketApiError(
      'NETWORK_ERROR',
      0,
      `Network error reaching Jira (${baseUrl}): ${err?.message || 'request failed'}`
    );
  }

  if (res.status === 401) {
    throw new BitbucketApiError(
      'AUTH_FAILED',
      401,
      'Jira authentication failed (401). Check your Atlassian email and Jira API token.'
    );
  }

  if (res.status === 403) {
    throw new BitbucketApiError(
      'MISSING_SCOPE',
      403,
      'Jira token lacks permission (403). Ensure read:jira-user / read:jira-work scopes are enabled.'
    );
  }

  if (!res.ok) {
    throw new BitbucketApiError(
      'API_ERROR',
      res.status,
      `Jira API error (${res.status}) while verifying credentials.`
    );
  }

  const data = await res.json();
  return {
    accountId: data.accountId || '',
    displayName: data.displayName || '',
    emailAddress: data.emailAddress || trimmedEmail,
  };
}
