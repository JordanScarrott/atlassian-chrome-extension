# Bitbucket PR Tracker (v1.1.0) — Setup & Installation Guide

**Bitbucket PR Tracker** (`v1.1.0`) is a Manifest V3 Chrome extension that keeps track of open Bitbucket Cloud pull requests you created and pull requests awaiting your review, with a live toolbar badge, background polling once an hour, and automatic refresh when you open the popup.

---

## Step 1: Create a Scoped Atlassian API Token

Legacy Bitbucket App Passwords have been retired. Use a scoped **Atlassian API Token** instead — **no Bitbucket admin permissions are required** (any standard Bitbucket Cloud member can create a personal read-only token).

1. Open [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) and sign in with your Atlassian account.
2. Click **Create API token with scopes**.
3. Give the token a descriptive label (for example, `Bitbucket PR Tracker`) and choose an expiration date.
4. Select **Bitbucket** as the app.
5. Enable the following **4 read-only scopes**:
   - `read:user:bitbucket` — verify your identity and match you as author/reviewer
   - `read:workspace:bitbucket` — discover workspaces you belong to
   - `read:repository:bitbucket` — list repositories when workspace PR listing falls back to repo-level queries
   - `read:pullrequest:bitbucket` — fetch open pull requests, descriptions, reviewers, and counts
6. Click **Create** and copy the generated token immediately (you will not be able to view it again).

### Optional: Bitbucket Access Token (Bearer) Mode

If you already have a Bitbucket Workspace, Project, or Repository **Access Token** (Bearer token) with the same read permissions, you can select the **Bitbucket Access Token** authentication option in the popup and paste your token without needing an Atlassian account email. Note that Workspace/Repo Access Tokens are scoped to that workspace or repository rather than all workspaces on your account.

---

## Step 2: Install the Extension in Chrome

1. Open Google Chrome (or another Chromium-based browser such as Edge or Brave) and navigate to `chrome://extensions`.
2. Toggle **Developer mode** on in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `bitbucket-pr-extension` folder (the directory containing `manifest.json`).
5. Click the **Extensions** (puzzle piece) icon in the Chrome toolbar and **pin** **Bitbucket PR Tracker** so the live badge stays visible.

---

## Step 3: Sign In Inside the Extension Popup

1. Click the **Bitbucket PR Tracker** icon in your Chrome toolbar to open the popup.
2. Choose **Atlassian API Token (Recommended)** (default) and enter:
   - Your **Atlassian account email**
   - Your scoped **Atlassian API token**
   *(Or switch to **Bitbucket Access Token** and paste your Bearer token.)*
3. Click **Sign In & Sync**.
4. The extension immediately verifies your credentials against `GET /2.0/user`, runs an initial PR sync, and stores your credentials and cached PR state locally in `chrome.storage.local` (never sent anywhere other than `https://api.bitbucket.org/*`).

---

## Step 4: Overview of the 3 Tabs

- **My PRs** (`#tab-my-prs` / `#panel-my-prs`): Lists open pull requests you authored, sorted by most recently updated. Shows the PR title, description, source → destination branches, repository name, reviewer approval status, and comment/task counts. Click any title link to open the PR on Bitbucket.
- **To Review** (`#tab-to-review` / `#panel-to-review`): Lists open pull requests where you are a reviewer (your own authored PRs never appear here). Pull requests are sorted by priority — **pending** reviews first, then **changes requested**, then **approved** — and by most recently updated within each group, alongside your review status and the full reviewer breakdown.
- **More** (`#tab-more` / `#panel-more`): An empty placeholder tab reserved for your future additions (such as Jira, Confluence, or custom integrations). When you are ready to extend it, edit `#tab-more` and `#panel-more` in `bitbucket-pr-extension/popup.html`, and wire up its tab handler and rendering logic in `bitbucket-pr-extension/popup.js`.

---

## Step 5: Toolbar Badge Legend & Troubleshooting

### Toolbar Badge Legend

| Badge | Color | Meaning |
| --- | --- | --- |
| Number (e.g. `3`) | **Orange** (`#FF9800`) | Count of open pull requests waiting on your **pending** review |
| Number (e.g. `2`) | **Blue** (`#0052CC`) | Count of your open authored PRs (shown when you have `0` pending reviews) |
| `ERR` | **Red** (`#DE350B`) | Authentication or sync error (open the popup for details) |
| *(empty)* | — | Signed out, or zero pending reviews and zero open authored PRs |

### Troubleshooting

- **`401` (`AUTH_FAILED`)**:
  - For **Atlassian API Token**, verify you entered your **Atlassian account email** (not a Bitbucket handle) and copied the full token with no extra spaces or newlines.
  - For **Bearer** mode, confirm the Bitbucket Access Token has not expired or been revoked.
- **`403` (`MISSING_SCOPE`)**:
  - Your token is missing one or more required read-only scopes. Re-create the scoped Atlassian API token and make sure all four scopes are enabled: `read:user:bitbucket`, `read:workspace:bitbucket`, `read:repository:bitbucket`, and `read:pullrequest:bitbucket`.
- **`429` (`RATE_LIMITED`)**:
  - Bitbucket Cloud API rate limit was reached. Wait a few minutes and click the refresh button in the popup (or wait for the next hourly background poll).
- **Inspecting Service Worker Logs**:
  - Go to `chrome://extensions`, locate **Bitbucket PR Tracker**, and click **service worker** under **Inspect views** to inspect background sync logs or network errors.
