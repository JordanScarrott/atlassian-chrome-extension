import {
  DECISION_MODELS,
  THROTTLE_CONFIG,
  sanitizeDecisionEndpointUrl
} from './config.js';
import { RequestTimeoutError, fetchWithTimeout } from './throttler.js';

/**
 * @typedef {'BAD_CONFIG' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'TIMEOUT' | 'NETWORK' | 'API_ERROR'} DecisionErrorCode
 */

/**
 * @typedef {{
 *   type: 'choice',
 *   instruction: string,
 *   choices: readonly string[]
 * } | {
 *   type: 'score',
 *   instruction: string,
 *   choices: readonly string[]
 * } | {
 *   type: 'noul',
 *   instruction: string
 * }} DecisionQuestionSpec
 */

/**
 * @typedef {Object} NormalizedDecisionAnswer
 * @property {'choice' | 'score' | 'noul'} type
 * @property {string} [choice]
 * @property {number} [noul]
 * @property {number} [score]
 * @property {Record<string, number> | number[]} [probabilities]
 * @property {number} confidence
 */

/**
 * Sanitized error thrown by System One Decision Model API calls.
 * Never embeds raw upstream response bodies or API keys.
 */
export class DecisionApiError extends Error {
  /**
   * @param {{
   *   status: number,
   *   code: DecisionErrorCode,
   *   message: string,
   *   isAuthError: boolean,
   *   isTransient: boolean
   * }} details
   */
  constructor({ status, code, message, isAuthError, isTransient }) {
    super(message);
    this.name = 'DecisionApiError';
    this.status = status;
    this.code = code;
    this.isAuthError = isAuthError;
    this.isTransient = isTransient;
  }
}

/**
 * Single-pass Feature #1 (Review Effort & Risk Triage) questions.
 * Every instruction is fully self-contained and never depends on the object key name.
 *
 * @type {Readonly<Record<string, DecisionQuestionSpec>>}
 */
export const EFFORT_RISK_QUESTIONS = Object.freeze({
  review_effort: Object.freeze({
    type: 'choice',
    instruction:
      'Estimate the engineering code-review effort required for this pull request based on the title, branch names, description, and file/line diffstat counts. ' +
      'Choose quick_lt_5m for tiny/trivial changes (under 5 minutes: typo, docs, small config tweak, or ~1-2 small files); ' +
      'medium_15m for standard self-contained feature/bugfix changes (~5-20 minutes); ' +
      'deep_30m_plus for large, cross-cutting, risky, or complex architectural changes needing 30+ minutes.',
    choices: Object.freeze(['quick_lt_5m', 'medium_15m', 'deep_30m_plus'])
  }),
  change_kind: Object.freeze({
    type: 'choice',
    instruction:
      'Classify the primary intent of this pull request from its title, branch name, description, and touched files: ' +
      'feature (new capability or enhancement), bugfix (ordinary defect fix), hotfix (urgent production outage/incident/rollback/revert fix), ' +
      'refactor (behavior-preserving code restructuring), tests_docs (tests or documentation only), ' +
      'config_deps (build, CI, infra config, or dependency updates), or other.',
    choices: Object.freeze(['feature', 'bugfix', 'hotfix', 'refactor', 'tests_docs', 'config_deps', 'other'])
  }),
  risk_score: Object.freeze({
    type: 'score',
    instruction:
      'Rate the production blast radius and regression risk of merging this pull request on a 5-point ordered scale from lowest risk (first choice) to critical production risk (last choice), ' +
      'considering touched paths (auth, payments, database migrations, core infra, security vs docs/tests/UI copy), change size, and urgency cues.',
    choices: Object.freeze([
      '1_trivial_docs_or_tests_no_runtime_impact',
      '2_low_isolated_ui_or_non_critical_change',
      '3_moderate_standard_service_or_logic_change',
      '4_high_shared_core_auth_data_or_large_blast_radius',
      '5_critical_security_migration_infra_or_outage_risk'
    ])
  }),
  is_urgent_unblock: Object.freeze({
    type: 'noul',
    instruction:
      'Is this pull request an urgent production hotfix, emergency rollback/revert, incident mitigation, or critical blocker that needs immediate review to unblock production?'
  }),
  needs_deep_risk_check: Object.freeze({
    type: 'noul',
    instruction:
      'Does this pull request modify sensitive or high-blast-radius systems (authentication, permissions, cryptography, billing/payments, database schema/migrations, deployment/CI secrets, or wide core refactors) that require extra careful review?'
  }),
  has_clear_context: Object.freeze({
    type: 'noul',
    instruction:
      'Do the pull request title, branch names, and description clearly explain what changed and why, giving a reviewer enough context to begin reviewing immediately?'
  })
});

/** @type {Readonly<Record<string, 'quick' | 'medium' | 'deep'>>} */
const EFFORT_CHOICE_MAP = Object.freeze({
  quick_lt_5m: 'quick',
  medium_15m: 'medium',
  deep_30m_plus: 'deep'
});

/**
 * Build a lean, structured text summary of a PR and its diffstat for System One evaluation.
 * Never includes raw code diff patches or hunks.
 *
 * @param {Partial<import('./storage.js').PullRequestRecord>} pr
 * @param {import('./storage.js').DiffstatSummary | null | undefined} [diffstat]
 * @returns {string}
 */
export function buildPrDecisionInput(pr, diffstat = null) {
  const safePr = pr && typeof pr === 'object' ? pr : {};
  const provider = safePr.provider === 'github' ? 'github' : 'bitbucket';
  const repo = typeof safePr.repoFullName === 'string' && safePr.repoFullName.trim()
    ? safePr.repoFullName.trim()
    : (typeof safePr.repoName === 'string' && safePr.repoName.trim() ? safePr.repoName.trim() : 'unknown-repo');
  const title = typeof safePr.title === 'string' && safePr.title.trim() ? safePr.title.trim() : 'Untitled PR';
  const sourceBranch = typeof safePr.sourceBranch === 'string' ? safePr.sourceBranch.trim() : '';
  const destinationBranch = typeof safePr.destinationBranch === 'string' ? safePr.destinationBranch.trim() : '';
  const branchLine = sourceBranch || destinationBranch
    ? `${sourceBranch || 'unknown'} -> ${destinationBranch || 'unknown'}`
    : 'unknown';

  const rawDescription = typeof safePr.description === 'string' ? safePr.description.trim() : '';
  const maxDescChars = THROTTLE_CONFIG.maxDescriptionCharsInPrompt;
  const description = rawDescription.length > maxDescChars
    ? `${rawDescription.slice(0, maxDescChars - 1)}…`
    : rawDescription;

  const lines = [
    `Provider: ${provider}`,
    `Repository: ${repo}`,
    `Branches: ${branchLine}`,
    `Draft: ${Boolean(safePr.draft) ? 'yes' : 'no'}`,
    `Title: ${title}`
  ];

  if (description) {
    lines.push(`Description: ${description}`);
  }

  const effectiveDiffstat = diffstat ?? safePr.diffstat ?? null;
  if (effectiveDiffstat && typeof effectiveDiffstat === 'object') {
    const filesChanged = typeof effectiveDiffstat.filesChanged === 'number' ? effectiveDiffstat.filesChanged : 0;
    const linesAdded = typeof effectiveDiffstat.linesAdded === 'number' ? effectiveDiffstat.linesAdded : 0;
    const linesRemoved = typeof effectiveDiffstat.linesRemoved === 'number' ? effectiveDiffstat.linesRemoved : 0;
    lines.push(`Diffstat: ${filesChanged} files changed, +${linesAdded} / -${linesRemoved} lines`);

    const files = Array.isArray(effectiveDiffstat.files) ? effectiveDiffstat.files : [];
    const maxFiles = THROTTLE_CONFIG.maxDiffstatFilesInPrompt;
    const visibleFiles = files.slice(0, maxFiles);
    if (visibleFiles.length > 0) {
      lines.push('Changed files:');
      for (const file of visibleFiles) {
        if (!file || typeof file.path !== 'string' || !file.path) {
          continue;
        }
        const added = typeof file.added === 'number' ? file.added : 0;
        const removed = typeof file.removed === 'number' ? file.removed : 0;
        const status = typeof file.status === 'string' && file.status ? ` [${file.status}]` : '';
        lines.push(`- ${file.path}${status} (+${added}/-${removed})`);
      }
      if (files.length > maxFiles) {
        lines.push(`- ...and ${files.length - maxFiles} more file(s)`);
      }
    }
  } else {
    lines.push('Diffstat: unavailable');
  }

  return lines.join('\n');
}

/**
 * Map an HTTP status code from Jev / Gemini Decisions into a sanitized `DecisionApiError`.
 *
 * @param {'jev' | 'gemini'} provider
 * @param {number} status
 * @returns {DecisionApiError}
 */
function mapHttpStatusToDecisionError(provider, status) {
  const providerLabel = provider === 'gemini' ? 'Gemini Decisions' : 'Jev / Clef Flash';

  if (status === 401 || status === 403) {
    return new DecisionApiError({
      status,
      code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
      message: `${providerLabel} rejected credentials (${status}). Check your API key and endpoint permissions.`,
      isAuthError: true,
      isTransient: false
    });
  }
  if (status === 404) {
    return new DecisionApiError({
      status,
      code: 'NOT_FOUND',
      message: `${providerLabel} endpoint was not found (404). Verify the base URL and model name.`,
      isAuthError: false,
      isTransient: false
    });
  }
  if (status === 429) {
    return new DecisionApiError({
      status,
      code: 'RATE_LIMITED',
      message: `${providerLabel} rate limit reached (429).`,
      isAuthError: false,
      isTransient: true
    });
  }
  if (status >= 500) {
    return new DecisionApiError({
      status,
      code: 'SERVER_ERROR',
      message: `${providerLabel} is temporarily unavailable (${status}).`,
      isAuthError: false,
      isTransient: true
    });
  }
  return new DecisionApiError({
    status,
    code: 'API_ERROR',
    message: `${providerLabel} returned unexpected status ${status}.`,
    isAuthError: false,
    isTransient: false
  });
}

/**
 * Clamp a probability value into `[0, 1]`.
 *
 * @param {unknown} val
 * @returns {number | null}
 */
function toProb(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    return null;
  }
  return Math.max(0, Math.min(1, val));
}

/**
 * Compute max probability from an array or map of probabilities.
 *
 * @param {unknown} probs
 * @returns {number | null}
 */
function maxProbability(probs) {
  if (Array.isArray(probs)) {
    let best = -1;
    for (const v of probs) {
      const p = toProb(v);
      if (p !== null && p > best) {
        best = p;
      }
    }
    return best >= 0 ? best : null;
  }
  if (probs && typeof probs === 'object') {
    let best = -1;
    for (const v of Object.values(probs)) {
      const p = toProb(v);
      if (p !== null && p > best) {
        best = p;
      }
    }
    return best >= 0 ? best : null;
  }
  return null;
}

/**
 * Normalize a single answer entry from either Jev (`/v1/systemone`) or Gemini (`/v1beta/decisions`)
 * into a consistent `{ type, choice?, noul?, score?, probabilities?, confidence }` shape.
 *
 * @param {DecisionQuestionSpec} spec
 * @param {unknown} rawAnswer
 * @returns {NormalizedDecisionAnswer}
 */
function normalizeDecisionAnswer(spec, rawAnswer) {
  const raw = rawAnswer && typeof rawAnswer === 'object' ? /** @type {Record<string, unknown>} */ (rawAnswer) : {};
  const rawProbs = raw.probabilities ?? raw.probs ?? undefined;
  const normalizedProbs = Array.isArray(rawProbs)
    ? rawProbs.map((v) => toProb(v) ?? 0)
    : (rawProbs && typeof rawProbs === 'object'
      ? /** @type {Record<string, number>} */ (
        Object.fromEntries(
          Object.entries(rawProbs).map(([k, v]) => [k, toProb(v) ?? 0])
        )
      )
      : undefined);

  if (spec.type === 'noul') {
    const noulCandidate = toProb(raw.noul) ?? toProb(raw.value) ?? toProb(raw.probability) ?? toProb(raw.p) ?? 0.5;
    const explicitConf = toProb(raw.confidence);
    const derivedConf = Math.max(noulCandidate, 1 - noulCandidate);
    const confidence = explicitConf ?? derivedConf;
    return {
      type: 'noul',
      noul: noulCandidate,
      ...(normalizedProbs !== undefined ? { probabilities: normalizedProbs } : {}),
      confidence
    };
  }

  if (spec.type === 'score') {
    let score = typeof raw.score === 'number' && Number.isFinite(raw.score)
      ? raw.score
      : (typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : null);

    let choice = typeof raw.choice === 'string' && raw.choice ? raw.choice : undefined;
    if (!choice && typeof raw.choiceIndex === 'number' && spec.choices[raw.choiceIndex]) {
      choice = spec.choices[raw.choiceIndex];
    }

    // If API returned probability distribution over ordered choices, derive expected 1..N score if score missing
    if (score === null && Array.isArray(normalizedProbs) && normalizedProbs.length > 0) {
      let weighted = 0;
      let totalWeight = 0;
      let bestIdx = 0;
      let bestProb = -1;
      for (let i = 0; i < normalizedProbs.length; i += 1) {
        const p = normalizedProbs[i];
        weighted += (i + 1) * p;
        totalWeight += p;
        if (p > bestProb) {
          bestProb = p;
          bestIdx = i;
        }
      }
      if (totalWeight > 0) {
        score = weighted / totalWeight;
      }
      if (!choice && spec.choices[bestIdx]) {
        choice = spec.choices[bestIdx];
      }
    } else if (score === null && normalizedProbs && !Array.isArray(normalizedProbs)) {
      let weighted = 0;
      let totalWeight = 0;
      let bestChoice = '';
      let bestProb = -1;
      for (let i = 0; i < spec.choices.length; i += 1) {
        const label = spec.choices[i];
        const p = toProb(normalizedProbs[label]) ?? 0;
        weighted += (i + 1) * p;
        totalWeight += p;
        if (p > bestProb) {
          bestProb = p;
          bestChoice = label;
        }
      }
      if (totalWeight > 0) {
        score = weighted / totalWeight;
      }
      if (!choice && bestChoice) {
        choice = bestChoice;
      }
    }

    if (score === null && choice) {
      const idx = spec.choices.indexOf(choice);
      if (idx >= 0) {
        score = idx + 1;
      }
    }

    const explicitConf = toProb(raw.confidence);
    let choiceProb = null;
    if (choice && normalizedProbs && !Array.isArray(normalizedProbs)) {
      choiceProb = toProb(normalizedProbs[choice]);
    }
    const confidence = explicitConf ?? choiceProb ?? maxProbability(normalizedProbs) ?? (score !== null ? 1 : 0);

    return {
      type: 'score',
      ...(choice ? { choice } : {}),
      ...(score !== null ? { score } : {}),
      ...(normalizedProbs !== undefined ? { probabilities: normalizedProbs } : {}),
      confidence
    };
  }

  // type === 'choice'
  let choice = typeof raw.choice === 'string' && raw.choice
    ? raw.choice
    : (typeof raw.value === 'string' && raw.value ? raw.value : undefined);
  if (!choice && typeof raw.choiceIndex === 'number' && spec.choices[raw.choiceIndex]) {
    choice = spec.choices[raw.choiceIndex];
  }
  if (!choice && normalizedProbs && !Array.isArray(normalizedProbs)) {
    let bestKey = '';
    let bestProb = -1;
    for (const [k, p] of Object.entries(normalizedProbs)) {
      if (p > bestProb) {
        bestProb = p;
        bestKey = k;
      }
    }
    if (bestKey) {
      choice = bestKey;
    }
  } else if (!choice && Array.isArray(normalizedProbs) && normalizedProbs.length > 0) {
    let bestIdx = 0;
    let bestProb = -1;
    for (let i = 0; i < normalizedProbs.length; i += 1) {
      if (normalizedProbs[i] > bestProb) {
        bestProb = normalizedProbs[i];
        bestIdx = i;
      }
    }
    if (spec.choices[bestIdx]) {
      choice = spec.choices[bestIdx];
    }
  }

  const explicitConf = toProb(raw.confidence);
  let choiceProb = null;
  if (choice && normalizedProbs && !Array.isArray(normalizedProbs)) {
    choiceProb = toProb(normalizedProbs[choice]);
  }
  const confidence = explicitConf ?? choiceProb ?? maxProbability(normalizedProbs) ?? (choice ? 1 : 0);

  return {
    type: 'choice',
    ...(choice ? { choice } : {}),
    ...(normalizedProbs !== undefined ? { probabilities: normalizedProbs } : {}),
    confidence
  };
}

/**
 * Split a question map into ordered chunks no larger than `maxPerChunk`.
 *
 * @param {Record<string, DecisionQuestionSpec>} questions
 * @param {number} maxPerChunk
 * @returns {Array<Record<string, DecisionQuestionSpec>>}
 */
function chunkQuestions(questions, maxPerChunk) {
  const entries = Object.entries(questions);
  if (entries.length === 0) {
    return [];
  }
  const size = Math.max(1, Math.floor(maxPerChunk));
  /** @type {Array<Record<string, DecisionQuestionSpec>>} */
  const chunks = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(Object.fromEntries(entries.slice(i, i + size)));
  }
  return chunks;
}

/**
 * Resolve and validate runtime provider settings (`provider`, `endpointUrl`, `model`, `apiKey`).
 *
 * @param {Partial<import('./storage.js').DecisionConfig> | null | undefined} config
 * @returns {{ provider: 'jev' | 'gemini', endpointUrl: string, model: string, apiKey: string }}
 */
function resolveValidatedProviderConfig(config) {
  const provider = config?.provider;
  if (provider !== 'jev' && provider !== 'gemini') {
    throw new DecisionApiError({
      status: 0,
      code: 'BAD_CONFIG',
      message: 'Decision model provider must be "jev" or "gemini".',
      isAuthError: false,
      isTransient: false
    });
  }

  const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';

  if (provider === 'jev') {
    const rawBase = typeof config?.baseUrl === 'string' && config.baseUrl.trim()
      ? config.baseUrl.trim()
      : DECISION_MODELS.JEV_API_BASE_URL.trim();
    const safeBase = sanitizeDecisionEndpointUrl(rawBase);
    if (!safeBase) {
      throw new DecisionApiError({
        status: 0,
        code: 'BAD_CONFIG',
        message: 'Jev / Clef Flash Base URL must be a valid https:// URL (or http:// for localhost / private LAN hosts).',
        isAuthError: false,
        isTransient: false
      });
    }
    const endpointUrl = safeBase.endsWith('/v1/systemone')
      ? safeBase
      : `${safeBase}/v1/systemone`;
    const model = (typeof config?.model === 'string' ? config.model.trim() : '') || DECISION_MODELS.JEV_DEFAULT_MODEL;
    return { provider, endpointUrl, model, apiKey };
  }

  // provider === 'gemini'
  if (!apiKey) {
    throw new DecisionApiError({
      status: 0,
      code: 'BAD_CONFIG',
      message: 'Gemini API key is required for Gemini Decision 1.',
      isAuthError: true,
      isTransient: false
    });
  }
  const rawBase = typeof config?.baseUrl === 'string' && config.baseUrl.trim()
    ? config.baseUrl.trim()
    : DECISION_MODELS.GEMINI_DECISIONS_URL;
  const safeBase = sanitizeDecisionEndpointUrl(rawBase);
  if (!safeBase) {
    throw new DecisionApiError({
      status: 0,
      code: 'BAD_CONFIG',
      message: 'Gemini Decisions URL must be a valid https:// URL.',
      isAuthError: false,
      isTransient: false
    });
  }
  const model = (typeof config?.model === 'string' ? config.model.trim() : '') || DECISION_MODELS.GEMINI_DEFAULT_MODEL;
  return { provider, endpointUrl: safeBase, model, apiKey };
}

/**
 * Create an interchangeable System One Decision Model client supporting both
 * TypeSafe Jev / Clef Flash (`/v1/systemone`) and Google Gemini Decisions (`gemini-decision-1`).
 *
 * @param {{
 *   fetchFn?: typeof fetch,
 *   nowFn?: () => number
 * }} [deps]
 */
export function createDecisionClient({
  fetchFn = fetch,
  nowFn = Date.now
} = {}) {
  /**
   * Execute a System One decision request (auto-chunking if question count exceeds provider limits)
   * and return normalized answers keyed by question name.
   *
   * @param {Partial<import('./storage.js').DecisionConfig>} config
   * @param {{ input: string, questions: Record<string, DecisionQuestionSpec> }} payload
   * @returns {Promise<Record<string, NormalizedDecisionAnswer>>}
   */
  async function decide(config, { input, questions }) {
    const resolved = resolveValidatedProviderConfig(config);
    const maxQuestions = resolved.provider === 'jev'
      ? DECISION_MODELS.JEV_MAX_QUESTIONS_PER_REQUEST
      : DECISION_MODELS.GEMINI_MAX_QUESTIONS_PER_REQUEST;

    const safeQuestions = questions && typeof questions === 'object' ? questions : {};
    const chunks = chunkQuestions(safeQuestions, maxQuestions);
    /** @type {Record<string, NormalizedDecisionAnswer>} */
    const normalizedAll = {};

    for (const chunk of chunks) {
      /** @type {Record<string, string>} */
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      };
      /** @type {Record<string, unknown>} */
      let bodyPayload;

      if (resolved.provider === 'jev') {
        if (resolved.apiKey) {
          headers.Authorization = `Bearer ${resolved.apiKey}`;
        }
        bodyPayload = {
          model: resolved.model,
          state: input,
          questions: chunk
        };
      } else {
        headers['x-goog-api-key'] = resolved.apiKey;
        bodyPayload = {
          model: resolved.model,
          input,
          questions: chunk
        };
      }

      let response;
      try {
        response = await fetchWithTimeout(
          fetchFn,
          resolved.endpointUrl,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyPayload)
          },
          THROTTLE_CONFIG.requestTimeoutMs
        );
      } catch (err) {
        if (err instanceof RequestTimeoutError) {
          throw new DecisionApiError({
            status: 0,
            code: 'TIMEOUT',
            message: 'Decision model request timed out. Check endpoint reachability and try again.',
            isAuthError: false,
            isTransient: true
          });
        }
        throw new DecisionApiError({
          status: 0,
          code: 'NETWORK',
          message: 'Could not reach decision model endpoint. Verify the URL and network access.',
          isAuthError: false,
          isTransient: true
        });
      }

      if (!response.ok) {
        throw mapHttpStatusToDecisionError(resolved.provider, response.status);
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw new DecisionApiError({
          status: response.status,
          code: 'API_ERROR',
          message: 'Received an unreadable JSON response from decision model endpoint.',
          isAuthError: false,
          isTransient: true
        });
      }

      const answerMap = data && typeof data === 'object'
        ? (data.answers ?? data.decisions ?? data.results ?? null)
        : null;

      if (!answerMap || typeof answerMap !== 'object' || Array.isArray(answerMap)) {
        throw new DecisionApiError({
          status: response.status,
          code: 'API_ERROR',
          message: 'Decision model response did not include an answers/decisions/results object.',
          isAuthError: false,
          isTransient: false
        });
      }

      for (const [qKey, spec] of Object.entries(chunk)) {
        normalizedAll[qKey] = normalizeDecisionAnswer(spec, /** @type {Record<string, unknown>} */ (answerMap)[qKey]);
      }
    }

    return normalizedAll;
  }

  /**
   * Verify endpoint URL, model name, and API key using a minimal 1-question `noul` test call.
   *
   * @param {Partial<import('./storage.js').DecisionConfig>} config
   * @returns {Promise<{ ok: true, provider: 'jev' | 'gemini', model: string, answer: NormalizedDecisionAnswer }>}
   */
  async function verifyConnection(config) {
    const resolved = resolveValidatedProviderConfig(config);
    const answers = await decide(config, {
      input: 'feat: add unit tests',
      questions: {
        is_pull_request: {
          type: 'noul',
          instruction: 'Is this a software pull request?'
        }
      }
    });
    return {
      ok: true,
      provider: resolved.provider,
      model: resolved.model,
      answer: answers.is_pull_request
    };
  }

  /**
   * Evaluate Feature #1 (Review Effort & Risk Triage) in a single pass for a PR + optional diffstat,
   * applying plain-JS cross-question consistency rules and `CONFIDENCE_THRESHOLD` (`0.75`) gating.
   *
   * @param {Partial<import('./storage.js').DecisionConfig>} config
   * @param {Partial<import('./storage.js').PullRequestRecord>} pr
   * @param {import('./storage.js').DiffstatSummary | null | undefined} [diffstat]
   * @returns {Promise<import('./storage.js').DecisionTriageResult>}
   */
  async function evaluateEffortAndRisk(config, pr, diffstat = null) {
    const resolved = resolveValidatedProviderConfig(config);
    const input = buildPrDecisionInput(pr, diffstat);
    const answers = await decide(config, {
      input,
      questions: /** @type {Record<string, DecisionQuestionSpec>} */ ({ ...EFFORT_RISK_QUESTIONS })
    });

    const threshold = DECISION_MODELS.CONFIDENCE_THRESHOLD;
    const effortAns = answers.review_effort;
    const effortConf = effortAns?.confidence ?? 0;
    const mappedEffort = effortAns?.choice ? (EFFORT_CHOICE_MAP[effortAns.choice] ?? null) : null;
    /** @type {'quick' | 'medium' | 'deep' | null} */
    const effort = mappedEffort && effortConf >= threshold ? mappedEffort : null;

    const kindAns = answers.change_kind;
    const kindConf = kindAns?.confidence ?? 0;
    const changeKind = kindAns?.choice && kindConf >= threshold ? kindAns.choice : null;

    const riskAns = answers.risk_score;
    const riskConf = riskAns?.confidence ?? 0;
    let riskScore = typeof riskAns?.score === 'number' && Number.isFinite(riskAns.score)
      ? riskAns.score
      : null;

    const urgentAns = answers.is_urgent_unblock;
    const urgentProb = urgentAns?.noul ?? 0;
    const urgentConf = urgentAns?.confidence ?? 0;

    const deepRiskAns = answers.needs_deep_risk_check;
    const deepRiskProb = deepRiskAns?.noul ?? 0;
    const deepRiskConf = deepRiskAns?.confidence ?? 0;

    const clearCtxAns = answers.has_clear_context;
    const clearCtxProb = clearCtxAns?.noul ?? 0.5;
    const clearCtxConf = clearCtxAns?.confidence ?? 0;
    const hasClearContext = clearCtxConf >= threshold ? clearCtxProb >= 0.5 : null;

    const isHotfixByKind = changeKind === 'hotfix' && kindConf >= threshold;
    const isHotfixByUrgency = urgentProb >= threshold && urgentConf >= threshold;
    const isHighRiskByCheck = deepRiskProb >= threshold && deepRiskConf >= threshold;
    const isHighRiskByScore = riskScore !== null && riskScore >= 4.0 && riskConf >= threshold;

    /** @type {'hotfix' | 'high_risk' | null} */
    let alert = null;
    let alertConfidence = 0;

    if (isHotfixByKind || isHotfixByUrgency) {
      alert = 'hotfix';
      alertConfidence = Math.max(
        isHotfixByKind ? kindConf : 0,
        isHotfixByUrgency ? Math.min(urgentProb, urgentConf) : 0
      );
      if (riskScore === null || riskScore < 3) {
        riskScore = 3;
      }
    } else if (isHighRiskByCheck || isHighRiskByScore) {
      alert = 'high_risk';
      alertConfidence = Math.max(
        isHighRiskByCheck ? Math.min(deepRiskProb, deepRiskConf) : 0,
        isHighRiskByScore ? riskConf : 0
      );
    }

    const commitHash = typeof pr?.sourceCommitHash === 'string'
      ? pr.sourceCommitHash.trim()
      : (typeof diffstat?.commitHash === 'string' ? diffstat.commitHash.trim() : '');

    return {
      commitHash,
      questionSetVersion: DECISION_MODELS.QUESTION_SET_VERSION,
      provider: resolved.provider,
      model: resolved.model,
      effort,
      effortConfidence: effortConf,
      alert,
      alertConfidence,
      changeKind,
      riskScore,
      hasClearContext,
      cachedAt: nowFn()
    };
  }

  return {
    decide,
    verifyConnection,
    evaluateEffortAndRisk
  };
}
