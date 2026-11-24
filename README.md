# Atlassian Extension Hub (Bitbucket + GitHub PR Tracker & Mezzanine Jira Hub)

A zero-build, Manifest V3 Chrome Extension (**v2.0.0**) that turns your browser toolbar into a low-cognitive-load **Bitbucket Cloud, GitHub & Atlassian PR Hub**. Built with native ES Modules, strict XSS/URL-sanitization guardrails, and an attention-set triage workflow inspired by Google's Critique/Gerrit "Your Turn" model.

---

## Features

- **"Your Turn" Attention Set (Authored & Reviewing):** Tracks both pull requests awaiting your review and PRs you authored across **Bitbucket Cloud** and **GitHub** (github.com or GitHub Enterprise Server). Automatically surfaces what requires your action (`Needs Action` vs `Reviewing`, `My PRs`, `All`, and `Snoozed`), surfaces unresolved tasks and change-request counts, ranks items by priority, and flags stale PRs (`24h` / `48h` / `72h`).
- **Modular GitHub Connection (`BB` / `GH`):** Connect Bitbucket Cloud, GitHub, or both simultaneously in **Settings (⚙) → Account & Setup**. When both providers are active (or when viewing GitHub PRs), cards display subtle `BB` / `GH` badges and the header status chip reflects your combined connections (`Bitbucket + GitHub`, `GitHub (@user)`, or Bitbucket display name).
- **By-Ticket Grouping (`g`) & Horizontal Ticket Decks:** Toggle **By Ticket** (`g`) to group open PRs by primary Jira key (e.g. `MEZ-123`) or `#123` issue reference. Multi-PR tickets render as a **Ticket Deck** (horizontal swipeable carousel sorted by urgency so slide 1 is always most urgent), complete with color-coded status dots (`1 / 3`), an off-screen `+N needs action →` indicator, `‹` / `›` or `h` / `l` navigation, and a `⊞` vertical-stack toggle.
- **Inline Related PRs (`🔗 +N`):** In flat list view, PR cards sharing a Jira key or `#123` issue ref across Bitbucket and GitHub show a clickable **`🔗 +N <TICKET>`** pill. Clicking it scopes the list to all related open PRs across providers (`Related PRs for PROJ-123 (3)` + **Show all** / `Esc`).
- **Live CI / Build Status & Presubmit Escalation:** Displays commit build status pills (`✓ CI`, `✕ CI`, `⟳ CI`, `■ CI`) directly on PR cards with deep links to CI runs, escalates authored PRs with failing builds to **CI Failed** (`Needs Action`), and supports search tokens (`ci:failed`, `ci:passing`, `ci:running`, `ci:stopped`).
- **Auto-Detected Jira Ticket Chips & Active Jira Tab:** Extracts Jira issue keys (e.g. `MEZ-123`) from PR titles, branch names, and descriptions, displays clickable chips directly on PR cards, and aggregates active tickets in the **Jira** tab with one-click **Filter PRs** drill-down.
- **Keyboard-First Triage & Smart Snooze:** Navigate (`j`/`k`, `h`/`l`, `ArrowLeft`/`ArrowRight` tablist navigation), open, copy links, refresh, and snooze PRs for 4 hours with an inline **Undo** toast and remaining duration indicator. Snoozed PRs automatically unsnooze early if new commits or comments update the PR.
- **Automatic Dark Mode & WCAG AA Contrast:** Automatically adapts to your OS theme via `@media (prefers-color-scheme: dark)` with high-contrast tokens in both light and dark modes.
- **Resilient Caching & Rate-Limit Stewardship:** Caches user profiles, workspaces, repositories, and commit build statuses with TTLs; deduplicates concurrent syncs; enforces a 10s manual refresh cooldown, 4-request concurrency cap, and 12s request timeouts; paces requests on `X-RateLimit-NearLimit`; and backs off automatically on HTTP `429 Retry-After` while keeping cached PRs usable (stale-while-revalidate).
- **Configurable Preferences:** Customize polling interval (`Manual` to `30m`), toolbar badge mode (`Needs Action`, `All Open PRs`, or `Off`), desktop notifications, stale threshold, default PR filter, compact card density, workspace/repository allowlists, **By Ticket** grouping, and Jira URL override.
- **Modular Atlassian Hub Tabs:** Switch between **Bitbucket PRs**, **Jira** (Active Jira Tickets + quick open), **Confluence** (quick launch when configured / integration roadmap), and **+ Add Product** (local feature request customizer).

---

## Quick Start (Zero Build Step)

The extension runs directly from source using native Manifest V3 ES Modules—no bundler or compilation step is required.

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `bitbucket-pr-extension/` directory.
4. Pin **Atlassian Extension Hub** to your toolbar, open it, and click **Connect Bitbucket** (with an Atlassian Scoped API Token or Access Token) and/or **Connect GitHub** (with a GitHub Personal Access Token).

For detailed authentication setup, scopes, and troubleshooting, see [bitbucket-pr-extension/INSTALLATION.md](./bitbucket-pr-extension/INSTALLATION.md).

---

## Configuring Central URLs (Mezzanine Jira, Confluence & GitHub Enterprise)

One-click Jira ticket deep links (`<base-url>/browse/<KEY>`), Confluence launch links, and default GitHub / GitHub Enterprise Server endpoints can be configured centrally in code or per-user in the UI:

1. **Central Configuration (Code):** Edit `CENTRAL_URLS` in [`bitbucket-pr-extension/src/config.js`](./bitbucket-pr-extension/src/config.js) with `https://` URLs and **no trailing slashes**:
   ```js
   export const CENTRAL_URLS = Object.freeze({
     MEZZANINE_JIRA_URL: 'https://mezzanine.jira.example.com',
     CONFLUENCE_URL: '',
     GITHUB_API_BASE_URL: 'https://api.github.com', // or 'https://github.company.com/api/v3' for GHES
     GITHUB_WEB_BASE_URL: 'https://github.com',     // or 'https://github.company.com' for GHES
     ...
   });
   ```
   *(Optionally set `CENTRAL_URLS.CONFLUENCE_URL` to enable quick-open links on the Confluence tab.)*
2. **Per-User Overrides (UI):**
   - **Jira URL:** Open **Settings (⚙) → Preferences → Jira Base URL Override**, enter your `https://` Jira base URL, and save.
   - **GitHub Enterprise API URL:** Open **Settings (⚙) → Account & Setup → GitHub → GitHub API Base URL**, enter your `https://.../api/v3` URL, and save.

---

## Keyboard Shortcuts

Press `?` anywhere in the popup (outside text inputs) to toggle the in-app shortcuts cheat sheet.

| Key | Action |
| :--- | :--- |
| `/` | Focus PR search bar (supports `ci:failed`, `ci:passing`, `ci:running`, `ci:stopped`, build names, Jira keys) |
| `g` | Toggle **By Ticket** grouping (with horizontal Ticket Decks) |
| `j` / `k` (or `↓` / `↑`) | Select next / previous PR card |
| `h` / `l` (or `←` / `→`) | Swipe previous / next PR inside a selected Ticket Deck |
| `Enter` | Open selected PR in a new tab |
| `c` | Copy selected PR URL to clipboard |
| `s` | Snooze PR for 4 hours / Unsnooze |
| `r` | Trigger manual PR sync |
| `1` – `4` | Switch top tabs (`Bitbucket PRs`, `Jira`, `Confluence`, `+ Add Product`) |
| `?` | Toggle keyboard shortcuts cheat sheet |
| `Esc` | Clear related scope / clear search filter / close open drawer or popover |

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
