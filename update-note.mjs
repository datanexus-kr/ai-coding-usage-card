#!/usr/bin/env node
// Rewrites the "사용량 노트" section of the profile README from the committed
// device ledgers, so the prose never drifts from the cards.
// Run after usage-card.mjs. Requires: Node 18+, GitHub CLI (`gh auth login`).
import { execSync } from 'node:child_process';

const REPO = process.env.USAGE_CARD_REPO;
const GH = process.env.GH_PATH ?? 'gh';
const DRY_RUN = process.argv.includes('--dry-run');
if (!REPO) throw new Error('Set USAGE_CARD_REPO, e.g. octocat/octocat');

const sh = (cmd, big = false) =>
  execSync(cmd, { encoding: 'utf8', maxBuffer: (big ? 128 : 32) * 1024 * 1024, windowsHide: true });
const api = (path, big = false) => JSON.parse(sh(`"${GH}" api "${path}"`, big));
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// --- collect every device ledger ---
const tree = api(`repos/${REPO}/git/trees/main?recursive=1`, true);
const ledgers = tree.tree
  .filter((x) => x.type === 'blob' && x.path.startsWith('cards/devices/') && x.path.endsWith('.json'))
  .map((x) => JSON.parse(b64(api(`repos/${REPO}/git/blobs/${x.sha}`, true).content)));
if (!ledgers.length) throw new Error('no device ledgers found');

const daily = new Map();
for (const l of ledgers)
  for (const e of l.daily || []) {
    const cur = daily.get(e.period);
    if (!cur) daily.set(e.period, structuredClone(e));
    else {
      for (const k of ['totalTokens', 'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalCost'])
        cur[k] = (cur[k] || 0) + (e[k] || 0);
      cur.modelBreakdowns = [...(cur.modelBreakdowns || []), ...(e.modelBreakdowns || [])];
    }
  }
const days = [...daily.values()].sort((a, b) => a.period.localeCompare(b.period));

const add = (map, k, v) => map.set(k, (map.get(k) || 0) + v);

const models = new Map(), months = new Map();
let tokens = 0, cacheRead = 0, cost = 0;
for (const e of days) {
  tokens += e.totalTokens || 0;
  cacheRead += e.cacheReadTokens || 0;
  cost += e.totalCost || 0;
  add(months, e.period.slice(0, 7), e.totalCost || 0);
  for (const m of e.modelBreakdowns || []) add(models, m.modelName, m.cost || 0);
}

// Per-tool cost comes from the same toolDaily/toolLegacy fields the cards render,
// so the note and the SVG never disagree. Claude Code is the remainder.
const toolCost = (from = '0000-00-00', to = '9999-99-99') => {
  const out = new Map();
  let others = 0;
  for (const l of ledgers)
    for (const [name, byDay] of Object.entries(l.toolDaily || {})) {
      const v = Object.entries(byDay).filter(([p]) => p >= from && p <= to).reduce((s, [, c]) => s + c, 0);
      add(out, name, v);
      others += v;
    }
  if (from === '0000-00-00')
    for (const l of ledgers)
      for (const [name, c] of Object.entries(l.toolLegacy || {})) { add(out, name, c); others += c; }
  const window = days.filter((e) => e.period >= from && e.period <= to).reduce((s, e) => s + (e.totalCost || 0), 0);
  out.set('Claude Code', Math.max(0, window - others));
  return new Map([...out].filter(([, c]) => c > 0));
};
const tools = toolCost();

const first = days[0].period, last = days.at(-1).period;
const peak = days.reduce((a, b) => ((b.totalCost || 0) > (a.totalCost || 0) ? b : a));
const monthList = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const peakMonth = monthList.reduce((a, b) => (b[1] > a[1] ? b : a));
const lastFull = monthList.filter(([m]) => m < last.slice(0, 7)).at(-1);

// last 30 days, per tool
const since = new Date(Date.parse(last + 'T00:00:00Z') - 29 * 864e5).toISOString().slice(0, 10);
const recent = toolCost(since);

const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const tok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : (n / 1e6).toFixed(0) + 'M');
const mon = (p) => Number(p.slice(5, 7)) + '월';
const part = (p) => { const d = +p.slice(8, 10); return d <= 10 ? '초' : d <= 20 ? ' 중순' : ' 말'; };
const span = () => {
  const [y1, m1] = first.split('-').map(Number), [y2, m2] = last.split('-').map(Number);
  const n = (y2 - y1) * 12 + (m2 - m1);
  return ['한', '두', '석', '넉', '다섯', '여섯', '일곱', '여덟', '아홉', '열'][n - 1] ?? n;
};

const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
const [tool1, tool2] = rank(tools);
const gemini = tools.get('Gemini') || 0;
const topModel = rank(models)[0];
const claudeTop = rank(models).find(([n]) => n.startsWith('claude'));
const [rec1, rec2] = rank(recent);

const note = `### 사용량 노트 <sub>${last} 기준</sub>

${mon(first)}${part(first)}부터 ${span()} 달 동안 AI 코딩 도구로 ${tok(tokens)} 토큰을 태웠다. API 정가로 환산하면 ${usd(cost)}인데 ${(cacheRead / tokens * 100).toFixed(1)}%가 캐시에서 읽은 토큰이라 실제 결제액이 아니라 환산치다.

툴별로는 ${tool1[0]} ${usd(tool1[1])}, ${tool2[0]} ${usd(tool2[1])} 순이고 Gemini는 ${gemini < 10 ? '써본 수준이다' : `${usd(gemini)} 정도다`}. 모델로 좁히면 ${topModel[0]} 하나가 ${usd(topModel[1])}으로 ${topModel[1] / cost > 0.4 ? '절반 가까이' : '가장 많이'} 가져간다. Claude 쪽은 ${claudeTop[0]}가 ${usd(claudeTop[1])}까지 올라왔다.

${mon(peakMonth[0])}이 ${usd(peakMonth[1])}로 월 최고였고 ${lastFull ? `${mon(lastFull[0])}은 ${usd(lastFull[1])}로 ${lastFull[1] < peakMonth[1] ? '꺾였다' : '더 올라갔다'}` : '아직 집계 중이다'}. 하루 최고 기록은 ${mon(peak.period)}${part(peak.period)}의 ${usd(peak.totalCost)}. 최근 30일만 떼어 보면 ${rec1[0]} ${usd(rec1[1])}, ${rec2[0]} ${usd(rec2[1])}로 ${rec1[0] === tool1[0] ? '순서가 그대로다' : '순서가 뒤집혔다'}.
`;

if (DRY_RUN) { console.log(note); process.exit(0); }

const meta = api(`repos/${REPO}/contents/README.md`);
const readme = b64(meta.content);
const re = /### 사용량 노트[\s\S]*?(?=\n### |\n## |$)/;
if (!re.test(readme)) throw new Error('"### 사용량 노트" section not found in README.md');
const next = readme.replace(re, note);
if (next === readme) { console.log(`[note] no change`); process.exit(0); }

const payload = JSON.stringify({
  message: `Update usage note: ${tok(tokens)} tokens, ${usd(cost)}`,
  content: Buffer.from(next, 'utf8').toString('base64'),
  sha: meta.sha,
});
// Pass the payload on stdin, never through the shell: a literal `$9,635` in
// the commit message would otherwise expand as a positional parameter.
execSync(`"${GH}" api -X PUT "repos/${REPO}/contents/README.md" --input -`, { input: payload, encoding: 'utf8', windowsHide: true });
console.log(`[note] updated: ${tok(tokens)} tokens, ${usd(cost)}`);
