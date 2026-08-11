# Atlassian Extension Hub Installation & Setup Guide

A production-ready Chrome Extension (Manifest V3) that centralizes your Atlassian workflow. Currently, it fully tracks open Bitbucket Pull Requests (showing live badges and interactive lists) and features modular tabs for **Jira**, **Confluence**, and a customized **Add Product** portal.

---

## 📋 Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Atlassian Connection Setup](#2-atlassian-connection-setup)
    - [Option A: Personal Access Token (PAT) - Recommended](#option-a-personal-access-token-pat---recommended)
    - [Option B: App Password](#option-b-app-password)
3. [Chrome Extension Installation](#3-chrome-extension-installation)
4. [Using the Tab Navigation Bar](#4-using-the-tab-navigation-bar)
    - [Bitbucket PRs Tab](#bitbucket-prs-tab)
    - [Jira (Coming Soon!)](#jira-coming-soon)
    - [Confluence (Coming Soon!)](#confluence-coming-soon)
    - [+ Add Product (Customizer)](#-add-product-customizer)
5. [Troubleshooting & Debugging](#5-troubleshooting--debugging)

---

## 1. Prerequisites
- An active **Bitbucket Cloud / Atlassian account** (e.g. hosted on `bitbucket.org`).
- **Google Chrome** (or any other Chromium browser with Manifest V3 support, such as Brave, Edge, or Opera).

---

## 2. Atlassian Connection Setup

To connect the extension securely, you should **never** use your main Atlassian password. Instead, generate a **Personal Access Token (PAT)** or an **App Password**. Both methods grant safe, limited, read-only permissions that you can revoke at any time.

### Option A: Personal Access Token (PAT) - *Recommended*
1. Log in to [Bitbucket Cloud](https://bitbucket.org).
2. Click your **avatar** in the bottom-left corner and choose **Personal settings**.
3. Under the **Access management** header, click **Personal access tokens**.
4. Click **Create token**.
5. Give your token a name (e.g., `Atlassian Hub Extension`).
6. Toggle the following permissions to **Read**:
   - **Repositories:** `Read`
   - **Pull requests:** `Read`
7. Click **Create** and **copy the generated token** immediately.

### Option B: App Password
1. Log in to [Bitbucket Cloud](https://bitbucket.org).
2. Click your **avatar** in the bottom-left corner and choose **Personal settings**.
3. Under **Access management**, select **App passwords**.
4. Click **Create app password**.
5. Give your app password a label (e.g., `Atlassian Hub Extension`).
6. Set the following scopes to **Read**:
   - **Repositories:** `Read`
   - **Pull Requests:** `Read`
7. Click **Create**.
8. **Copy the password** immediately, and note down your **Bitbucket username** (found under *Personal settings* > *Account settings*).

---

## 3. Chrome Extension Installation

Load the extension into your browser using Google Chrome's developer mode:

1. Open **Google Chrome**.
2. Navigate to `chrome://extensions/`.
3. In the top-right corner, turn on **Developer mode**.
4. In the top-left corner, click **Load unpacked**.
5. Select the `bitbucket-pr-extension/` directory (the folder containing `manifest.json`).
6. The **Atlassian Hub** will be loaded. Click the puzzle-piece icon in your Chrome toolbar and **pin** the extension for quick access.

---

## 4. Using the Tab Navigation Bar

Our extension features a modern, clean, Atlassian-inspired tab structure that lets you seamlessly switch views:

### 🟢 Bitbucket PRs Tab
- **The Core Tracker:** Once credentials are configured, this tab displays a scrollable card-list of your open pull requests.
- **Badge Indicator:** The extension icon badge glows **Atlassian Blue (`#0052CC`)** and displays the active count of your open pull requests.
- **Instant Actions:** Click any pull request card to open it directly in a new browser tab.
- **Sync Now:** Use the refresh icon in the tab header to force a manual synchronization on-demand.

### 🔵 Jira (Coming Soon!)
- A dedicated view that will aggregate all of your assigned Jira issues, active sprints, and status boards directly inside the popup.
- Stay tuned! This tab is scheduled for release in the upcoming version.

### 🟡 Confluence (Coming Soon!)
- A dedicated view that will list your saved documents, collaboratively edited spaces, and blog announcements.
- This feature is coming soon to keep you up-to-date with your team's knowledgebase.

### 🟣 + Add Product (Customizer)
- **Want more products?** Open this tab to select which integrations you would like next (e.g., Jira Service Management, Trello Boards, Bitbucket Pipelines & Builds, Compass Component Catalog).
- **Submit Feedback:** Write down your custom requirements in the text box and click **Save Product Request**. This saves your feedback locally and helps guide future development!

---

## 5. Troubleshooting & Debugging

- **Badge Shows "ERR" in Red:** This indicates authentication or network failure. Open Settings (gear icon) and verify your token. Ensure no accidental trailing spaces are copied.
- **Inspecting Background Log Console:** Navigate to `chrome://extensions/`, find the **Atlassian Hub** card, and click the link next to *Inspect views* labeled `service worker` to view active fetch request logs or debug exceptions.
