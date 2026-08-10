# Bitbucket PR Tracker Extension Installation Guide

A production-ready Chrome Extension (Manifest V3) that tracks open Bitbucket Pull Requests and shows the active PR count directly on the extension's badge icon.

---

## 📋 Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [How to Create Bitbucket Credentials (Securely)](#2-how-to-create-bitbucket-credentials-securely)
    - [Option A: Personal Access Token (PAT) - Recommended](#option-a-personal-access-token-pat---recommended)
    - [Option B: App Password](#option-b-app-password)
3. [Chrome Extension Installation Guide](#3-chrome-extension-installation-guide)
4. [First-Time Configuration & Verification](#4-first-time-configuration--verification)
5. [Troubleshooting & Debugging](#5-troubleshooting--debugging)

---

## 1. Prerequisites
- **Bitbucket Cloud Account** (e.g., hosted on `bitbucket.org`).
- **Google Chrome Browser** (or any Chromium-based browser supporting Manifest V3, such as Brave, Edge, or Opera).

---

## 2. How to Create Bitbucket Credentials (Securely)

Connecting the extension securely is standard practice. You should **never** use your main Atlassian password. Instead, configure either a **Personal Access Token (PAT)** or an **App Password**. Both methods ensure that permissions are scoped strictly to `Read` operations and can be revoked at any time.

### Option A: Personal Access Token (PAT) - *Recommended*
*Personal Access Tokens are ideal for secure personal or workspace integration.*

1. Log in to your [Bitbucket Cloud](https://bitbucket.org) account.
2. Click your **avatar / profile icon** in the bottom-left corner and choose **Personal settings**.
3. Under the **Access management** header in the left sidebar, click **Personal access tokens**.
4. Click **Create token**.
5. Give your token a recognizable name (e.g., `Chrome PR Tracker`).
6. Set the following permissions:
   - **Repositories:** `Read`
   - **Pull requests:** `Read`
7. Click **Create**.
8. **Copy the generated token immediately!** (You will not be able to view it again).

### Option B: App Password
*If your organization has disabled Personal Access Tokens, use an App Password instead.*

1. Log in to your [Bitbucket Cloud](https://bitbucket.org) account.
2. Click your **avatar / profile icon** in the bottom-left corner and choose **Personal settings**.
3. In the sidebar under **Access management**, select **App passwords**.
4. Click **Create app password**.
5. Give your app password a label (e.g., `Chrome PR Tracker`).
6. Set the following scopes:
   - **Repositories:** `Read`
   - **Pull Requests:** `Read`
7. Click **Create**.
8. **Copy the generated password** immediately, and take note of your **Bitbucket username** (visible under *Personal settings* > *Account settings*).

---

## 3. Chrome Extension Installation Guide

Since this is a custom extension, you will load it into Chrome as an **unpacked developer extension**:

1. Open **Google Chrome**.
2. Navigate to the Extensions page by typing `chrome://extensions/` in the URL bar, or by clicking the puzzle piece icon on the toolbar and selecting **Manage Extensions**.
3. In the top-right corner, toggle the **Developer mode** switch to **ON**.
4. In the top-left corner, click **Load unpacked**.
5. Browse to and select the `bitbucket-pr-extension/` directory (the folder containing `manifest.json`).
6. The extension is now loaded! You should see the **Bitbucket PR Tracker** tile appear.
7. Click the **puzzle piece icon** on your Chrome toolbar and click the **pin icon** next to **Bitbucket PR Tracker** to keep it visible on your browser bar.

---

## 4. First-Time Configuration & Verification

1. Click on the newly pinned **Bitbucket PR Tracker** icon in your browser toolbar.
2. If this is your first time, the popup will display a welcoming configuration hint. Click **Configure Extension** or the **Gear icon** in the top-right corner to open the Settings panel.
3. Choose your preferred **Authentication Type**:
   - For **PAT (Recommended)**: Choose `Personal Access Token (PAT)` and paste the copied token.
   - For **App Password**: Choose `App Password`, enter your `Bitbucket Username`, and paste the generated App Password.
4. Click the **Save & Sync** button.
5. The extension will perform an initial connection to the Bitbucket Cloud API:
   - If successful, the popup will list your open pull requests and display a last-updated timestamp.
   - The extension badge icon on your Chrome toolbar will turn **Atlassian Blue (`#0052CC`)** and show the current number of open PRs.
   - The extension will automatically refresh your PR list every **5 minutes** in the background.

---

## 5. Troubleshooting & Debugging

### The Badge Shows "ERR" (Red Background)
The `"ERR"` state indicates that a network request failed or your credentials were rejected.
- **Check Credentials:** Click the settings icon in the popup and verify your token. Ensure there are no accidental trailing or leading spaces in the input fields.
- **Check Scopes:** Confirm that your PAT or App Password has both `Repositories: Read` and `Pull requests: Read` permissions.
- **Check Network:** Verify that you have an active internet connection and that `https://api.bitbucket.org` is not blocked by your firewall/VPN.

### Inspecting Background Logs
Because background scripts run in isolated environment workers, you can view logs and errors directly:
1. Navigate to `chrome://extensions/`.
2. Find the **Bitbucket PR Tracker** card.
3. Click the link next to **Inspect views** labeled **service worker**.
4. This opens a dedicated Developer Tools window showing console output, errors, and network traffic generated by `background.js`.

### Forcing a Refresh
If you want to pull updates immediately without waiting for the 5-minute schedule:
- Open the extension popup.
- Click the circular **Sync now** icon in the header.
