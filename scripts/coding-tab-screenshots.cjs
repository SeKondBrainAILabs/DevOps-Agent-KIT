#!/usr/bin/env node
/**
 * Screenshots of the Kanvas Coding tab (KC-S2.1.x visual acceptance criteria).
 *
 *   npx electron-vite build && node scripts/coding-tab-screenshots.cjs [outDir]
 *
 * Serves the built renderer (dist/renderer), stubs window.api (the harness part
 * answers from fixtures captured from a real kit-harness run, with token counts
 * and extra stories so every board column has cards), and drives it in Chromium.
 * Set PLAYWRIGHT_CHROMIUM to a Chromium binary if Playwright's own is not installed.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const FX = path.join(ROOT, 'tests', 'kanvas', 'fixtures', 'harness');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'images', 'coding-tab'));
fs.mkdirSync(OUT, { recursive: true });
const runs = JSON.parse(fs.readFileSync(`${FX}/runs.json`));
const storyDone = JSON.parse(fs.readFileSync(`${FX}/story-done.json`));
const storyGated = JSON.parse(fs.readFileSync(`${FX}/story-gated.json`));
const events = JSON.parse(fs.readFileSync(`${FX}/events-done.json`));
const logoFile = fs.readdirSync(path.join(DIST, 'assets')).find((f) => f.startsWith('logo-with-name'));
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(DIST, 'assets', logoFile)).toString('base64');

// Real fixtures, with token counts and a spread of states so every column has cards.
const scale = { refiner: [3200, 900], planner: [5400, 1700], 'test-writer': [14200, 3900], coder: [41800, 9600], 'qa-functional': [0, 0], reviewer: [11800, 1400] };
for (const run of runs) {
  run.role_totals = Object.fromEntries(Object.entries(run.role_totals).map(([r, u]) => [r, { ...u, tokens_in: scale[r][0] * u.sessions, tokens_out: scale[r][1] * u.sessions }]));
  const t = Object.values(run.role_totals).reduce((a, u) => ({ sessions: a.sessions + u.sessions, tokens_in: a.tokens_in + u.tokens_in, tokens_out: a.tokens_out + u.tokens_out, cost: 0 }), { sessions: 0, tokens_in: 0, tokens_out: 0, cost: 0 });
  run.totals = t;
  for (const s of run.stories) s.tokens = { ...t, tokens_in: Math.round(t.tokens_in / run.stories.length), tokens_out: Math.round(t.tokens_out / run.stories.length) };
}
const extra = [
  ['KC-S2.1.4', 'Live run stream in the Coding tab', 'coding', 2],
  ['KC-S2.1.6', 'Evidence viewer with screenshots', 'qa_visual', 1],
  ['KC-S2.1.3', 'Runs and stories board', 'reviewing', 1],
  ['KC-S2.1.7', 'Per-role token meter', 'refining', 0],
  ['KC-S2.1.5', 'Plan approval and question gates', 'blocked', 0, ['Should answers re-queue the story or wait for a second approval?', 'Is three questions the right cap?']],
  ['KC-S2.2.9', 'Retire the legacy Tauri shell', 'failed', 3],
  ['KC-S2.1.8', 'Keyboard shortcuts for the board', 'queued', 0],
];
runs.push({ run_id: '20260929T150102-kanvas', status: 'running', created_at: '2026-09-29T15:01:02Z', epic: 'KC-E2.1 Coding tab', stories: extra.map(([id, title, state, rounds, questions]) => ({ story_id: id, title, state, rounds, questions: questions || [], tokens: { sessions: 3, tokens_in: 18000 + rounds * 9000, tokens_out: 4000, cost: 0 } })), role_totals: runs[0].role_totals, totals: runs[0].totals });
const blocked = { ...storyDone, story_id: 'KC-S2.1.5', title: 'Plan approval and question gates', state: 'blocked', pr_url: null, questions: runs[2].stories[4].questions, evidence: null };
const visual = {
  ...storyDone, story_id: 'KC-S2.1.6', title: 'Evidence viewer with screenshots', state: 'qa_visual', pr_url: 'https://github.com/SeKondBrainAILabs/DevOps-Agent-KIT/pull/30',
  evidence: { ...storyDone.evidence, story_id: 'KC-S2.1.6', acceptance_criteria: [
    storyDone.evidence.acceptance_criteria[0],
    { id: 'AC2', text: 'The header shows the KIT logo with its name', tests: ['tests/e2e/header.spec.ts'], passed: true,
      visual: { ac: 'AC2', pass: true, confidence: 0.91, screenshot: '/srv/kit/.kit/runs/r/KC-S2.1.6/screenshots/ac2-header.png', finding: 'Logo and wordmark are visible in the header', advisory: true } },
    { id: 'AC3', text: 'Failing checks show their output', tests: ['tests/unit/evidence.test.ts'], passed: false,
      checks: [{ command: 'npm test -- EvidencePanel', exit_code: 1, output_tail: 'FAIL tests/unit/evidence.test.ts\n  ✕ shows output for failing checks (12 ms)\n\n  Expected: "exit 1"\n  Received: undefined' }] },
  ] },
};
const diff = [
  'diff --git a/hello.txt b/hello.txt', 'new file mode 100644', 'index 0000000..3b18e51', '--- /dev/null', '+++ b/hello.txt', '@@ -0,0 +1 @@', '+hello world',
  'diff --git a/tests/test_hello.sh b/tests/test_hello.sh', 'new file mode 100755', 'index 0000000..8d2f1c3', '--- /dev/null', '+++ b/tests/test_hello.sh', '@@ -0,0 +1,3 @@', '+#!/bin/sh', "+grep -q 'hello world' hello.txt", '+echo ok',
].join('\n');
const data = { runs, storyDone, storyGated, blocked, visual, events, logo, diff };

const init = ({ data, mode }) => {
  const ok = (d) => Promise.resolve({ success: true, data: d });
  function anyApi() {
    const result = () => undefined;
    const settled = Promise.resolve({ success: true, data: [] });
    result.then = (a, b) => settled.then(a, b);
    result.catch = (f) => settled.catch(f);
    result.finally = (f) => settled.finally(f);
    return new Proxy(() => result, { get: (_t, p) => (p === 'then' ? undefined : anyApi()), apply: () => result });
  }
  const base = anyApi();
  const byStory = { 'KC-S9.9.3': data.storyGated, 'KC-S2.1.5': data.blocked, 'KC-S2.1.6': data.visual };
  const harness = {
    connection: () => ok({ url: 'http://mac-mini:39200/mcp', hasToken: true }),
    setConnection: (url) => ok({ url, hasToken: true }),
    listRuns: () => mode === 'offline'
      ? Promise.resolve({ success: false, error: { code: 'HARNESS_OFFLINE', message: 'KIT Harness unreachable at http://mac-mini:39299/mcp: fetch failed (ECONNREFUSED)' } })
      : ok(data.runs.map((r) => ({ run_id: r.run_id, status: r.status, created_at: r.created_at, stories: {} }))),
    getRun: (id) => ok(data.runs.find((r) => r.run_id === id)),
    getStory: (_r, s) => ok(byStory[s] || { ...data.storyDone, story_id: s }),
    events: () => ok(data.events),
    clusterStatus: () => mode === 'offline'
      ? Promise.resolve({ success: false, error: { code: 'HARNESS_OFFLINE', message: 'unreachable' } })
      : ok({ litellm: { ok: true }, devops_agent: { ok: true, url: 'http://127.0.0.1:39100/mcp' },
          lanes: { 'kit-planner': { ok: true }, 'kit-builder': { ok: true }, 'kit-reviewer': { ok: true }, 'kit-vision': { ok: true }, 'kit-fast': { ok: false, detail: 'kit-fast not configured in LiteLLM' } } }),
    storyDiff: () => ok({ base: '915ca9f0fe9dbe9778a59cf8a3a1901d5cdb9a56', diff: data.diff, truncated: false,
      files: [{ path: 'hello.txt', status: 'added', additions: 1, deletions: 0 }, { path: 'tests/test_hello.sh', status: 'added', additions: 3, deletions: 0 }] }),
    screenshot: () => ok(data.logo),
    approve: () => ok({}), answer: () => ok({}), pause: () => ok({}), resume: () => ok({}), cancel: () => ok({}),
  };
  const config = { get: () => ok(true), getAll: () => ok({}), set: () => ok(undefined) };
  const app = { getVersion: () => Promise.resolve('2.9.0'), getPlatform: () => Promise.resolve('darwin') };
  const special = { harness, config, app };
  window.api = new Proxy({}, { get: (_t, p) => (p in special ? special[p] : base[p]) });
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
  const shoot = async (name, mode, steps) => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(init, { data, mode });
    await page.goto(`${base}/index.html`);
    await page.waitForTimeout(600);
    if (steps) await steps(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(name, errors.length ? `errors: ${errors.slice(0, 3).join(' | ')}` : 'ok');
    await page.close();
  };
  await shoot('01-launch-coding-first', 'ok');
  await shoot('02-board-columns', 'ok', async (p) => { await p.getByTestId('coding-board').waitFor(); });
  await shoot('03-run-view-timeline', 'ok', async (p) => { await p.getByTestId('story-card-KC-S9.9.1').click(); await p.getByTestId('timeline-step-5').waitFor(); });
  await shoot('04-run-view-diff', 'ok', async (p) => {
    await p.getByTestId('story-card-KC-S9.9.1').click(); await p.getByText('Load diff').click();
    await p.getByTestId('diff-panel').scrollIntoViewIfNeeded(); });
  await shoot('05-plan-approval', 'ok', async (p) => { await p.getByTestId('story-card-KC-S9.9.3').click(); await p.getByTestId('plan-approval').waitFor(); });
  await shoot('06-question-gate', 'ok', async (p) => { await p.getByTestId('story-card-KC-S2.1.5').click(); await p.getByTestId('question-card').waitFor(); });
  await shoot('07-evidence-visual', 'ok', async (p) => {
    await p.getByTestId('story-card-KC-S2.1.6').click(); await p.getByAltText('Screenshot for AC2').waitFor();
    await p.getByTestId('evidence-panel').scrollIntoViewIfNeeded(); });
  await shoot('08-offline-bad-url', 'offline', async (p) => { await p.getByTestId('harness-offline').waitFor(); });
  await browser.close();
  server.close();
})();
