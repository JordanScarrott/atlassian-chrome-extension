import test from 'node:test';
import assert from 'node:assert/strict';

import { DECISION_MODELS, THROTTLE_CONFIG } from '../bitbucket-pr-extension/src/config.js';
import {
  DecisionApiError,
  EFFORT_RISK_QUESTIONS,
  buildPrDecisionInput,
  createDecisionClient
} from '../bitbucket-pr-extension/src/decision-client.js';

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('EFFORT_RISK_QUESTIONS defines 6 self-contained questions across choice, score, and noul', () => {
  const keys = Object.keys(EFFORT_RISK_QUESTIONS);
  assert.deepEqual(keys, [
    'review_effort',
    'change_kind',
    'risk_score',
    'is_urgent_unblock',
    'needs_deep_risk_check',
    'has_clear_context'
  ]);

  assert.equal(EFFORT_RISK_QUESTIONS.review_effort.type, 'choice');
  assert.deepEqual(EFFORT_RISK_QUESTIONS.review_effort.choices, ['quick_lt_5m', 'medium_15m', 'deep_30m_plus']);
  assert.equal(EFFORT_RISK_QUESTIONS.change_kind.type, 'choice');
  assert.equal(EFFORT_RISK_QUESTIONS.risk_score.type, 'score');
  assert.equal(EFFORT_RISK_QUESTIONS.risk_score.choices.length, 5);
  assert.equal(EFFORT_RISK_QUESTIONS.is_urgent_unblock.type, 'noul');
  assert.equal(EFFORT_RISK_QUESTIONS.needs_deep_risk_check.type, 'noul');
  assert.equal(EFFORT_RISK_QUESTIONS.has_clear_context.type, 'noul');
});

test('buildPrDecisionInput formats metadata + diffstat, truncates description to 800 chars, and excludes raw patches', () => {
  const longDesc = `Summary: fix auth flow.\n${'A'.repeat(1000)}`;
  const files = Array.from({ length: 30 }, (_, idx) => ({
    path: `src/file-${idx}.js`,
    added: 10 + idx,
    removed: 2,
    status: 'modified',
    patch: '@@ -1,2 +1,2 @@\n-const secretPatchLeak = true;\n+const secretPatchLeak = false;'
  }));

  const input = buildPrDecisionInput(
    {
      provider: 'github',
      repoFullName: 'acme/web',
      title: 'Fix OAuth token validation',
      description: longDesc,
      sourceBranch: 'fix/oauth',
      destinationBranch: 'main',
      draft: false
    },
    {
      commitHash: 'abc123',
      filesChanged: 30,
      linesAdded: 500,
      linesRemoved: 60,
      files,
      cachedAt: 1000
    }
  );

  assert.ok(input.includes('Provider: github'));
  assert.ok(input.includes('Repository: acme/web'));
  assert.ok(input.includes('Branches: fix/oauth -> main'));
  assert.ok(input.includes('Title: Fix OAuth token validation'));
  assert.ok(input.includes('Diffstat: 30 files changed, +500 / -60 lines'));
  assert.ok(input.includes('src/file-0.js [modified] (+10/-2)'));
  assert.ok(input.includes(`src/file-${THROTTLE_CONFIG.maxDiffstatFilesInPrompt - 1}.js`));
  assert.equal(input.includes(`src/file-${THROTTLE_CONFIG.maxDiffstatFilesInPrompt}.js`), false);
  assert.ok(input.includes('...and 5 more file(s)'));
  assert.equal(input.includes('secretPatchLeak'), false);
  assert.equal(input.includes('@@ -1,2'), false);

  const descLine = input.split('\n').find((line) => line.startsWith('Description: ')) || '';
  assert.ok(descLine.length <= 'Description: '.length + THROTTLE_CONFIG.maxDescriptionCharsInPrompt);
});

test('createDecisionClient supports Jev / Clef Flash wire format, keyless LAN endpoints, /v1/systemone suffix handling, and auto-chunking', async () => {
  /** @type {Array<{ url: string, headers: Record<string, string>, body: any }>} */
  const calls = [];

  const client = createDecisionClient({
    nowFn: () => 50_000,
    fetchFn: async (url, init) => {
      const headers = /** @type {Record<string, string>} */ (init?.headers ?? {});
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url: String(url), headers, body });

      /** @type {Record<string, unknown>} */
      const answers = {};
      for (const [key, spec] of Object.entries(body.questions)) {
        if (spec.type === 'noul') {
          answers[key] = { noul: 0.91, confidence: 0.91 };
        } else {
          answers[key] = { choice: spec.choices[0], confidence: 0.88 };
        }
      }
      return jsonResponse({ answers });
    }
  });

  // 1. Keyless internal HTTP Clef Flash server + auto-appended /v1/systemone
  const verifyRes = await client.verifyConnection({
    provider: 'jev',
    baseUrl: 'http://10.0.1.50:8080/',
    model: 'clef-flash',
    apiKey: ''
  });
  assert.equal(verifyRes.ok, true);
  assert.equal(verifyRes.provider, 'jev');
  assert.equal(verifyRes.model, 'clef-flash');
  assert.equal(calls[0].url, 'http://10.0.1.50:8080/v1/systemone');
  assert.equal('Authorization' in calls[0].headers, false);
  assert.equal(calls[0].body.model, 'clef-flash');
  assert.equal(calls[0].body.state, 'feat: add unit tests');

  // 2. Endpoint already ending with /v1/systemone + Bearer API key + auto-chunking (> 16 questions)
  calls.length = 0;
  /** @type {Record<string, { type: 'noul', instruction: string }>} */
  const manyQuestions = {};
  for (let i = 0; i < DECISION_MODELS.JEV_MAX_QUESTIONS_PER_REQUEST + 4; i += 1) {
    manyQuestions[`q_${i}`] = { type: 'noul', instruction: `Question ${i}?` };
  }

  const chunked = await client.decide(
    {
      provider: 'jev',
      baseUrl: 'https://clef.internal.example.com/v1/systemone',
      model: 'clef-flash',
      apiKey: 'jev-secret-key'
    },
    { input: 'PR summary', questions: manyQuestions }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://clef.internal.example.com/v1/systemone');
  assert.equal(calls[0].headers.Authorization, 'Bearer jev-secret-key');
  assert.equal(Object.keys(calls[0].body.questions).length, 16);
  assert.equal(Object.keys(calls[1].body.questions).length, 4);
  assert.equal(Object.keys(chunked).length, 20);
  assert.equal(chunked.q_19.noul, 0.91);
});

test('createDecisionClient supports Gemini Decision 1 wire format (x-goog-api-key, input, decisions/results normalization)', async () => {
  /** @type {Array<{ url: string, headers: Record<string, string>, body: any }>} */
  const calls = [];

  const client = createDecisionClient({
    nowFn: () => 99_000,
    fetchFn: async (url, init) => {
      const headers = /** @type {Record<string, string>} */ (init?.headers ?? {});
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url: String(url), headers, body });

      return jsonResponse({
        decisions: {
          review_effort: {
            probabilities: { quick_lt_5m: 0.05, medium_15m: 0.85, deep_30m_plus: 0.1 }
          },
          change_kind: {
            choice: 'feature',
            confidence: 0.92
          },
          risk_score: {
            probabilities: [0.05, 0.15, 0.7, 0.1, 0.0]
          },
          is_urgent_unblock: { noul: 0.08 },
          needs_deep_risk_check: { noul: 0.12 },
          has_clear_context: { noul: 0.86 }
        }
      });
    }
  });

  const triage = await client.evaluateEffortAndRisk(
    {
      provider: 'gemini',
      baseUrl: '',
      model: '',
      apiKey: 'AIzaTestKey123'
    },
    {
      provider: 'bitbucket',
      repoFullName: 'acme/api',
      title: 'Add metrics endpoint',
      sourceBranch: 'feat/metrics',
      destinationBranch: 'main',
      sourceCommitHash: 'deadbeef'
    },
    null
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DECISION_MODELS.GEMINI_DECISIONS_URL);
  assert.equal(calls[0].headers['x-goog-api-key'], 'AIzaTestKey123');
  assert.equal(calls[0].body.model, 'gemini-decision-1');
  assert.ok(typeof calls[0].body.input === 'string' && calls[0].body.input.includes('Add metrics endpoint'));

  assert.equal(triage.provider, 'gemini');
  assert.equal(triage.model, 'gemini-decision-1');
  assert.equal(triage.commitHash, 'deadbeef');
  assert.equal(triage.effort, 'medium');
  assert.equal(triage.effortConfidence, 0.85);
  assert.equal(triage.alert, null);
  assert.equal(triage.changeKind, 'feature');
  assert.ok(typeof triage.riskScore === 'number' && triage.riskScore > 2.5 && triage.riskScore < 3.5);
  assert.equal(triage.hasClearContext, true);
  assert.equal(triage.cachedAt, 99_000);
});

test('evaluateEffortAndRisk enforces confidence >= 0.75 gating and cross-question consistency rules (hotfix > high_risk)', async () => {
  // Case A: Low-confidence effort (< 0.75) yields effort: null, while hotfix urgency triggers hotfix alert and floors riskScore >= 3
  let responseMode = 'hotfix_override';
  const client = createDecisionClient({
    nowFn: () => 123_000,
    fetchFn: async () => {
      if (responseMode === 'hotfix_override') {
        return jsonResponse({
          results: {
            review_effort: { choice: 'quick_lt_5m', confidence: 0.62 },
            change_kind: { choice: 'bugfix', confidence: 0.8 },
            risk_score: { score: 2.0, confidence: 0.85 },
            is_urgent_unblock: { noul: 0.88, confidence: 0.88 },
            needs_deep_risk_check: { noul: 0.9, confidence: 0.9 },
            has_clear_context: { noul: 0.6, confidence: 0.6 }
          }
        });
      }
      // Case B: High risk via risk_score >= 4.0 and high confidence
      return jsonResponse({
        answers: {
          review_effort: { choice: 'deep_30m_plus', confidence: 0.91 },
          change_kind: { choice: 'refactor', confidence: 0.84 },
          risk_score: { score: 4.4, confidence: 0.82 },
          is_urgent_unblock: { noul: 0.1, confidence: 0.9 },
          needs_deep_risk_check: { noul: 0.65, confidence: 0.65 },
          has_clear_context: { noul: 0.12, confidence: 0.88 }
        }
      });
    }
  });

  const hotfixTriage = await client.evaluateEffortAndRisk(
    { provider: 'jev', baseUrl: 'https://clef.internal.example.com', model: 'clef-flash', apiKey: '' },
    { repoFullName: 'acme/api', title: 'Revert broken auth middleware', sourceCommitHash: 'sha-1' }
  );

  assert.equal(hotfixTriage.effort, null); // gated because 0.62 < 0.75
  assert.equal(hotfixTriage.alert, 'hotfix'); // hotfix takes precedence over needs_deep_risk_check
  assert.equal(hotfixTriage.riskScore, 3); // floored at >= 3 for hotfix
  assert.equal(hotfixTriage.hasClearContext, null); // gated because 0.6 < 0.75

  responseMode = 'high_risk';
  const highRiskTriage = await client.evaluateEffortAndRisk(
    { provider: 'jev', baseUrl: 'https://clef.internal.example.com', model: 'clef-flash', apiKey: '' },
    { repoFullName: 'acme/api', title: 'Rewrite billing schema', sourceCommitHash: 'sha-2' }
  );

  assert.equal(highRiskTriage.effort, 'deep');
  assert.equal(highRiskTriage.alert, 'high_risk');
  assert.equal(highRiskTriage.riskScore, 4.4);
  assert.equal(highRiskTriage.hasClearContext, false);
});

test('createDecisionClient validates URLs/API keys and sanitizes HTTP errors into DecisionApiError', async () => {
  const client = createDecisionClient({
    fetchFn: async () => new Response('{"secret":"internal trace"}', { status: 401 })
  });

  await assert.rejects(
    () => client.verifyConnection({ provider: 'gemini', apiKey: '' }),
    (err) => err instanceof DecisionApiError && err.code === 'BAD_CONFIG' && err.isAuthError === true
  );

  await assert.rejects(
    () => client.verifyConnection({ provider: 'jev', baseUrl: 'http://public-insecure.example.com', apiKey: '' }),
    (err) => err instanceof DecisionApiError && err.code === 'BAD_CONFIG'
  );

  await assert.rejects(
    () => client.verifyConnection({ provider: 'gemini', apiKey: 'bad-key' }),
    (err) =>
      err instanceof DecisionApiError &&
      err.status === 401 &&
      err.code === 'UNAUTHORIZED' &&
      err.isAuthError === true &&
      !err.message.includes('internal trace')
  );
});
