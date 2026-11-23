# Bitbucket PR Tracker (Chrome Extension)

A lightweight Manifest V3 Chrome extension that tracks your open Bitbucket Cloud pull requests and pending code reviews with a live toolbar badge and background polling.

## Features

- **My PRs & To Review**: Automatically separates open PRs you authored from PRs where you are a reviewer, sorting pending reviews to the top.
- **Scoped Atlassian API Token Auth**: Supports read-only scoped Atlassian API tokens (with optional Bitbucket Bearer Access Token support) — no Bitbucket admin permissions required.
- **Live Toolbar Badge**: Highlights pending review counts in orange (`#FF9800`), your open PR counts in blue (`#0052CC`), and sync errors in red (`ERR`).
- **Extensible Structure**: Includes a **More** tab ready for future Atlassian integrations.

## Setup & Installation

See [bitbucket-pr-extension/INSTALLATION.md](bitbucket-pr-extension/INSTALLATION.md) for step-by-step instructions on creating a scoped Atlassian API token, loading the extension in Chrome, and troubleshooting.

## Running Unit Tests

Unit tests use [Bun](https://bun.sh/) (`bun:test`) and cover PR normalization/partitioning (`bitbucket-pr-extension/lib/pr-model.js`) and the Bitbucket API client (`bitbucket-pr-extension/lib/bitbucket.js`):

```sh
bun test
```
