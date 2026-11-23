# Atlassian Extension Hub (Bitbucket PR Tracker & Mezzanine Jira Hub)

A zero-build, Manifest V3 Chrome Extension (**v2.0.0**) that turns your browser toolbar into a low-cognitive-load **Bitbucket Cloud PR & Atlassian Hub**. Built with native ES Modules, strict XSS/URL-sanitization guardrails, and an attention-set triage workflow inspired by Google's Critique/Gerrit "Your Turn" model.

---

## Features

- **"Your Turn" Attention Set (Authored & Reviewing):** Tracks both pull requests awaiting your review and PRs you authored. Automatically surfaces what requires your action (`Needs Action` vs `Reviewing`, `My PRs`, `All`, and `Snoozed`), surfaces unresolved tasks and change-request counts, ranks items by priority, and flags stale PRs (`24h` / `48h` / `72h`).
- **Live CI / Build Status & Presubmit Escalation:** Displays commit build status pills (`✓ CI`, `✕ CI`, `⟳ CI`, `■ CI`) directly on PR cards with deep links to CI runs, escalates authored PRs with failing builds to **CI Failed** (`Needs Action`), and supports search tokens (`ci:failed`, `ci:passing`, `ci:running`, `ci:stopped`).
- **Auto-Detected Jira Ticket Chips & Active Jira Tab:** Extracts Jira issue keys (e.g. `MEZ-123`) from PR titles and branch names, displays clickable chips directly on PR cards, and aggregates active tickets in the **Jira** tab with one-click **Filter PRs** drill-down.
- **Keyboard-First Triage & Smart Snooze:** Navigate (`j`/`k`, `ArrowLeft`/`ArrowRight` tablist navigation), open, copy links, refresh, and snooze PRs for 4 hours with an inline **Undo** toast and remaining duration indicator. Snoozed PRs automatically unsnooze early if new commits or comments update the PR.
- **Automatic Dark Mode & WCAG AA Contrast:** Automatically adapts to your OS theme via `@media (prefers-color-scheme: dark)` with high-contrast Atlassian tokens in both light and dark modes.
- **Resilient Caching & Rate-Limit Stewardship:** Caches user profile, workspaces, repositories, and commit build statuses with TTLs; deduplicates concurrent syncs; enforces a 10s manual refresh cooldown, 4-request concurrency cap, and 12s request timeouts; paces requests on `X-RateLimit-NearLimit`; and backs off automatically on HTTP `429 Retry-After` while keeping cached PRs usable (stale-while-revalidate).
- **Configurable Preferences:** Customize polling interval (`Manual` to `30m`), toolbar badge mode (`Needs Action`, `All Open PRs`, or `Off`), desktop notifications, stale threshold, default PR filter, compact card density, workspace/repository allowlists, and Jira URL override.
- **Modular Atlassian Hub Tabs:** Switch between **Bitbucket PRs**, **Jira** (Active Jira Tickets + quick open), **Confluence** (quick launch when configured / integration roadmap), and **+ Add Product** (local feature request customizer).

---

## Quick Start (Zero Build Step)

The extension runs directly from source using native Manifest V3 ES Modules—no bundler or compilation step is required.

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `bitbucket-pr-extension/` directory.
4. Pin **Atlassian Extension Hub** to your toolbar, open it, and click **Connect Bitbucket** to enter your Atlassian Scoped API Token (or Workspace/Repository Access Token).

For detailed authentication setup, scopes, and troubleshooting, see [bitbucket-pr-extension/INSTALLATION.md](./bitbucket-pr-extension/INSTALLATION.md).

---

## Configuring the Mezzanine Jira URL

One-click Jira ticket deep links (`<base-url>/browse/<KEY>`) and the **Open Mezzanine Jira** button can be configured centrally in code or per-user in the UI:

1. **Central Configuration (Code):** Edit `CENTRAL_URLS.MEZZANINE_JIRA_URL` in [`bitbucket-pr-extension/src/config.js`](./bitbucket-pr-extension/src/config.js) with an `https://` URL and **no trailing slash**:
   ```js
   export const CENTRAL_URLS = Object.freeze({
     MEZZANINE_JIRA_URL: 'https://mezzanine.jira.example.com',
     CONFLUENCE_URL: '',
     ...
   });
   ```
   *(Optionally set `CENTRAL_URLS.CONFLUENCE_URL` to enable quick-open links on the Confluence tab.)*
2. **Per-User Override (UI):** Open **Settings (⚙) → Preferences → Jira Base URL Override**, enter your `https://` Jira base URL, and save. A valid Preferences override takes precedence over `CENTRAL_URLS.MEZZANINE_JIRA_URL`.

---

## Keyboard Shortcuts

Press `?` anywhere in the popup (outside text inputs) to toggle the in-app shortcuts cheat sheet.

| Key | Action |
| :--- | :--- |
| `/` | Focus PR search bar (supports `ci:failed`, `ci:passing`, `ci:running`, `ci:stopped`, build names, Jira keys) |
| `j` / `k` (or `↓` / `↑`) | Select next / previous PR card |
| `Enter` | Open selected PR in a new tab |
| `c` | Copy selected PR URL to clipboard |
| `s` | Snooze PR for 4 hours / Unsnooze |
| `r` | Trigger manual PR sync |
| `1` – `4` | Switch top tabs (`Bitbucket PRs`, `Jira`, `Confluence`, `+ Add Product`) |
| `?` | Toggle keyboard shortcuts cheat sheet |
| `Esc` | Clear search filter or close open drawer/popover |

---

## Development & Verification

Requires **[Bun](https://bun.sh/) >= 1.1**.

```bash
# Install dev dependencies (ESLint, TypeScript, @types/chrome)
bun install

# Run all quality gates: extension manifest/icon/security check, ESLint, JSDoc checkJs typecheck, and unit tests
bun run verify

# Build a Chrome Web Store / sideload zip archive in dist/ (gitignored)
bun run package

# Regenerate extension PNG icons in bitbucket-pr-extension/icons/
bun run generate-icons
```

Individual checks can also be run via `bun run verify:extension`, `bun run lint`, `bun run typecheck`, and `bun test tests`. See [CODING_STANDARDS.md](./CODING_STANDARDS.md) for architecture and security conventions.
