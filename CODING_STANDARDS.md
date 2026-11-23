# Coding Standards & Pit-of-Success Guardrails

This repository builds a zero-build, Manifest V3 Chrome extension using native ES Modules and JSDoc type checking. Every rule below is designed to make the safe, maintainable, testable path the default path.

## 1. Native MV3 ESM (Zero Build Step)
- All extension code under `bitbucket-pr-extension/` MUST run directly in Chrome without transpilation or bundling.
- Use native ES Modules: `"type": "module"` in `manifest.json` for `background.js` and `<script type="module" src="popup.js">` in `popup.html`.
- Use explicit `.js` extensions on all relative module imports.

## 2. Pure, Testable Domain Modules
- Keep business logic, API clients, rate limiting, storage wrappers, and triage scoring inside `bitbucket-pr-extension/src/*.js` as pure or dependency-injected modules.
- External side effects (`fetch`, `chrome.*` APIs, `Date.now()`) should be injectable so unit and integration tests run deterministically under `node --test` without browser harnesses.
- Keep `background.js` and `popup.js` as thin orchestration/UI layers over `src/`.

## 3. Type Safety via JSDoc + TypeScript (`checkJs`)
- All `.js` files under `bitbucket-pr-extension/` are type-checked with `tsc --noEmit` (`checkJs: true`, `strictNullChecks: true`).
- Document all exported functions, parameters, return types, and shared domain structures with JSDoc `@typedef`, `@param`, and `@returns` annotations.
- Never suppress type errors with `@ts-ignore` unless strictly documented and unavoidable.

## 4. Security & XSS Prevention
- **No `innerHTML` with untrusted strings**: Always build dynamic DOM nodes using `document.createElement(...)`, `textContent`, `setAttribute`, and `replaceChildren()`. Never interpolate API data (PR titles, branch names, author names, repo slugs, error messages) into HTML strings.
- **Strict `https:` URL validation**: Validate every external URL (PR links, Jira base URLs, Confluence URLs) through `new URL(...)` and require `protocol === "https:"` before rendering clickable links or calling `chrome.tabs.create`.
- **No `eval` / `unescape` / `alert`**: `eval`, `new Function`, `unescape`, `window.alert`, `window.confirm`, and `window.prompt` are forbidden. Use accessible inline UI states and banners instead of blocking browser dialogs.

## 5. Credential & Error Hygiene
- **Never inject plaintext credentials into the DOM**: Do not populate `<input>` values or `dataset` attributes with stored API tokens or Basic auth headers. Display only non-secret connection status (e.g., masked indicator, authenticated display name/workspace).
- **No raw API error dumps**: Sanitize HTTP and network errors into concise, actionable user-facing messages. Never log or render `Authorization` headers, tokens, or raw upstream response bodies in the UI.
- Use UTF-8 safe encoding (e.g., `TextEncoder` + `btoa` over bytes) rather than deprecated `unescape(encodeURIComponent(...))` for Basic auth headers.

## 6. Resilience & Rate-Limit Stewardship
- Deduplicate concurrent sync requests, enforce manual refresh cooldowns, bound concurrent API requests, respect `429 Retry-After` and `X-RateLimit-NearLimit` headers, and apply `AbortController` timeouts to every network call.
- Implement stale-while-revalidate UI behavior so cached PRs remain usable if a background refresh fails transiently.

## 7. Automated Verification Gate
Before completing any change, all checks in `npm run verify` must pass:
1. `npm run verify:extension` — validates `manifest.json` (MV3), icon PNG headers/dimensions, and forbidden pattern checks.
2. `npm run lint` — ESLint 9 flat config rules (`no-alert`, `no-eval`, `eqeqeq`, `prefer-const`, `no-var`, `no-unused-vars`).
3. `npm run typecheck` — `tsc --noEmit` across `bitbucket-pr-extension/**/*.js`.
4. `npm test` — `node --test tests/**/*.test.mjs`.
