# Atlassian Extension Hub — Installation & Setup Guide (v2.0.0)

**Atlassian Extension Hub** is a zero-build, Manifest V3 Chrome Extension that centralizes your Bitbucket Cloud & GitHub pull requests, linked Jira tickets, and Atlassian workspace shortcuts in a fast, low-cognitive-load popup.

---

## Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Bitbucket Cloud Authentication Setup](#2-bitbucket-cloud-authentication-setup)
    - [Option A: Atlassian Scoped API Token (Recommended)](#option-a-atlassian-scoped-api-token-recommended)
    - [Option B: Workspace / Repository Access Token (Bearer)](#option-b-workspace--repository-access-token-bearer)
3. [GitHub & GitHub Enterprise Server Setup (Optional)](#3-github--github-enterprise-server-setup-optional)
4. [Chrome Extension Installation](#4-chrome-extension-installation)
5. [Configuring Mezzanine Jira, GHES & Preferences](#5-configuring-mezzanine-jira-ghes--preferences)
6. [Using the Hub Tabs, By-Ticket Decks & Related PRs](#6-using-the-hub-tabs-by-ticket-decks--related-prs)
7. [Troubleshooting & Debugging](#7-troubleshooting--debugging)

---

## 1. Prerequisites
- An active **Bitbucket Cloud** (`bitbucket.org`) and/or **GitHub** (`github.com` or GitHub Enterprise Server) account.
- **Google Chrome** (or a Chromium-based browser supporting Manifest V3 such as Edge, Brave, or Arc).

---

## 2. Bitbucket Cloud Authentication Setup

Bitbucket Cloud deprecated legacy App Passwords in favor of **Atlassian Scoped API Tokens** (and Workspace/Repository Access Tokens). Never enter your main Atlassian account password into the extension.

### Option A: Atlassian Scoped API Token *(Recommended)*
Use your Atlassian account email paired with a scoped API token (`Basic` authentication).

1. Open [Atlassian Account Security — API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Click **Create API token with scopes** (or **Create API token**).
3. Give the token a descriptive name (e.g., `Atlassian Extension Hub`) and choose an expiration date.
4. Select **Bitbucket** and grant these **4 required read scopes**:
   - `read:user:bitbucket`
   - `read:workspace:bitbucket`
   - `read:repository:bitbucket`
   - `read:pullrequest:bitbucket`
5. Create and **copy the token** immediately.
6. In the extension's **Settings (⚙) → Account & Setup → Bitbucket Cloud**:
   - **Authentication Method:** `Atlassian API Token (Email + Token)`
   - **Atlassian Account Email:** Your Atlassian login email (e.g., `you@company.com`)
   - **Atlassian API Token:** Paste the scoped token you generated
7. Click **Test Connection** to verify credentials and workspace access, then click **Save & Sync**.

### Option B: Workspace / Repository Access Token (Bearer)
If you prefer scoping access strictly to a single workspace or repository via a Bitbucket Access Token:

1. In Bitbucket Cloud, open your **Workspace settings** or **Repository settings** → **Access tokens**.
2. Create an Access Token with **Repositories: Read** and **Pull requests: Read** permissions.
3. Copy the generated token.
4. In the extension's **Settings (⚙) → Account & Setup → Bitbucket Cloud**:
   - **Authentication Method:** `Access Token (Bearer)`
   - **Access Token:** Paste the Bearer token (no email/username is required).
5. Click **Test Connection**, then **Save & Sync**.

> **Security Note:** Credentials are stored locally in `chrome.storage.local` and are never re-populated into DOM inputs after saving. Use **Replace Token** or **Sign Out** in each provider's Account summary card to rotate or clear them independently.

---

## 3. GitHub & GitHub Enterprise Server Setup (Optional)

GitHub integration is modular—you can connect **GitHub only**, **Bitbucket only**, or **both side-by-side**.

1. Open [GitHub Personal Access Tokens](https://github.com/settings/tokens) (or your GitHub Enterprise Server `/settings/tokens` page).
2. Create either:
   - A **Classic PAT** with the `repo` scope (for private + public repositories), **or**
   - A **Fine-Grained PAT** with **Pull requests: Read** and **Commit statuses: Read** repository permissions.
3. Open the extension's **Settings (⚙) → Account & Setup → GitHub**:
   - **GitHub Personal Access Token:** Paste your PAT (`ghp_...` or `github_pat_...`).
   - **GitHub API Base URL (optional):** Leave blank/default (`https://api.github.com`) for `github.com`, or enter your GitHub Enterprise Server REST API v3 base URL (e.g. `https://github.company.com/api/v3`).
4. Click **Test Connection** to verify your `@username`, then click **Save & Sync**.

> **Central GHES Default:** Teams using GitHub Enterprise Server can also set `CENTRAL_URLS.GITHUB_API_BASE_URL` and `CENTRAL_URLS.GITHUB_WEB_BASE_URL` once in `bitbucket-pr-extension/src/config.js` (and add their GHES host under `host_permissions` in `manifest.json` if needed).

---

## 4. Chrome Extension Installation

Load the extension directly from source—no build step is required:

1. Open Google Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `bitbucket-pr-extension/` directory (the folder containing `manifest.json`).
5. Click the puzzle-piece icon in the Chrome toolbar and **pin** **Atlassian Extension Hub**.

*(If you generated a packaged archive with `bun run package`, unzip `dist/atlassian-hub-v2.0.0.zip` and select the extracted folder when loading unpacked.)*

---

## 5. Configuring Mezzanine Jira, GHES & Preferences

### Hardcoding Central URLs (`src/config.js`)
To configure shared Mezzanine Jira, optional Confluence, or GitHub Enterprise Server URLs for everyone using your unpacked copy:

1. Open `bitbucket-pr-extension/src/config.js`.
2. Set `CENTRAL_URLS` fields (must start with `https://`, with **no trailing slash**):
   ```js
   export const CENTRAL_URLS = Object.freeze({
     MEZZANINE_JIRA_URL: 'https://mezzanine.jira.example.com',
     CONFLUENCE_URL: '',
     GITHUB_API_BASE_URL: 'https://api.github.com', // or 'https://github.company.com/api/v3'
     GITHUB_WEB_BASE_URL: 'https://github.com',     // or 'https://github.company.com'
     ...
   });
   ```
3. Reload the extension on `chrome://extensions/` if it is already loaded.

### Overriding Jira URL & Triage Settings in Preferences
Users can override the central URL and customize sync behavior at any time in **Settings (⚙) → Preferences**:
- **Jira Base URL Override:** Enter any `https://` Jira base URL (takes precedence over `CENTRAL_URLS.MEZZANINE_JIRA_URL`).
- **Polling Interval:** `Manual only`, `1`, `5`, `15`, or `30` minutes.
- **Toolbar Badge:** Count `Needs Action`, `All Open PRs`, or `Off`.
- **Stale Threshold:** Flag inactive PRs after `24`, `48`, or `72` hours.
- **Default PR View & Compact Mode:** Choose the landing filter pill and card density.
- **Desktop Notifications:** Receive notifications when PRs enter `Needs Action`.
- **Workspaces Filter / Watched Repos Filter:** Limit Bitbucket syncing to specific workspace slugs or `workspace/repo` slugs for faster polling and lower API usage.

---

## 6. Using the Hub Tabs, By-Ticket Decks & Related PRs

- **PR Triage Tab (`1`):**
  - Filter across **Needs Action** ("Your Turn" to review, address requested changes, or merge approved PRs), **Reviewing**, **My PRs**, **All**, and **Snoozed**.
  - **By-Ticket Grouping (`g`):** Click **By Ticket** (or press `g`) to group open PRs across Bitbucket (`BB`) and GitHub (`GH`) by their primary Jira ticket or `#123` issue reference. Multi-PR tickets render as a horizontal swipeable **Ticket Deck** sorted by Attention Set urgency (slide 1 is always most urgent), with color-coded status dots (`Red` = CI Failed / Changes Requested, `Blue` = Needs Review, `Green` = Ready / Approved, `Gray` = Waiting / Draft), an off-screen `+N needs action →` indicator, `‹` / `›` or `h` / `l` navigation, and a `⊞` toggle to stack cards vertically.
  - **Inline Related PRs (`🔗 +N`):** In flat list view, when multiple open PRs share a Jira key or `#123` issue ref across Bitbucket and/or GitHub, click the **`🔗 +N <TICKET>`** badge on any card to scope the view to every related PR (`Related PRs for PROJ-123 (3)`). Click **Show all** or press `Esc` to return.
  - Search instantly with `/` across titles, repositories, authors, branches, CI checks (`ci:failed`, `ci:passing`, `ci:running`, `ci:stopped`), and Jira keys.
  - Use `j`/`k` to select cards, `h`/`l` to swipe inside a Ticket Deck, `Enter` to open, `c` to copy the link, `s` to **Snooze 4h** (auto-unsnoozes on new PR activity), `r` to sync, and `?` for the shortcuts reference.
- **Jira (`2`):** Displays **Active Jira Tickets** auto-extracted from your open PR titles, branches, and descriptions across Bitbucket & GitHub, with one-click deep links to Mezzanine Jira when configured.
- **Confluence (`3`):** Quick-launches `CENTRAL_URLS.CONFLUENCE_URL` when configured, or previews upcoming Confluence integration.
- **+ Add Product (`4`):** Select additional Atlassian integrations you want prioritized and save custom feedback locally.

---

## 7. Troubleshooting & Debugging

- **Run Test Connection First:** In **Settings (⚙) → Account & Setup**, click **Test Connection** under Bitbucket Cloud or GitHub before saving.
  - `401 Unauthorized`: Verify your Atlassian Account Email matches the Bitbucket token (or switch to `Access Token (Bearer)`), or check that your GitHub PAT has not expired or been mistyped.
  - `403 Forbidden` / Missing Data:
    - For Bitbucket, confirm your Scoped API Token includes `read:user:bitbucket`, `read:workspace:bitbucket`, `read:repository:bitbucket`, and `read:pullrequest:bitbucket`.
    - For GitHub, confirm your PAT has `repo` (classic) or `Pull requests: Read` + `Commit statuses: Read` (fine-grained).
- **Rate Limits & Backoff Banners:**
  - If you see a **Rate Limit Notice** or **Polling Paused** banner, the extension is pacing requests or respecting a `429 Retry-After` / GitHub `X-RateLimit-Reset` header. Cached PRs remain visible while polling recovers.
  - **Fix for large Bitbucket organizations:** Open **Settings (⚙) → Preferences** and populate **Workspaces Filter** (e.g. `my-workspace`) and/or **Watched Repos Filter** (e.g. `my-workspace/web-app, my-workspace/api`) to avoid scanning dozens of unrelated repositories.
- **Jira Chips Are Not Clickable:** Confirm an `https://` URL is set in `CENTRAL_URLS.MEZZANINE_JIRA_URL` (`src/config.js`) or **Preferences → Jira Base URL Override**. Non-HTTPS URLs are rejected for security.
- **Inspecting Background Service Worker Logs:** Go to `chrome://extensions/`, locate **Atlassian Extension Hub**, and click **service worker** under *Inspect views* to inspect network/sync diagnostics.
