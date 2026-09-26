#!/usr/bin/env node
// Rewrites the "사용량 노트" section of the profile README from the committed
// device ledgers, so the prose never drifts from the cards.
// Run after usage-card.mjs. Requires: Node 18+, GitHub CLI (`gh auth login`).
import { createGitHubClient } from './github-client.mjs';
import { buildEnrichedNote, replaceUsageNote } from './usage-insights.mjs';

const REPO = process.env.USAGE_CARD_REPO;
const GH = process.env.GH_PATH ?? 'gh';
const DRY_RUN = process.argv.includes('--dry-run');
if (!REPO) throw new Error('Set USAGE_CARD_REPO, e.g. octocat/octocat');

const { api, assertWriteAccess } = createGitHubClient({ repo: REPO, gh: GH });
await assertWriteAccess();
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// --- collect every device ledger ---
const tree = await api(`repos/${REPO}/git/trees/main?recursive=1`);
const ledgers = await Promise.all(tree.tree
  .filter((x) => x.type === 'blob' && x.path.startsWith('cards/devices/') && x.path.endsWith('.json'))
  .map(async (x) => JSON.parse(b64((await api(`repos/${REPO}/git/blobs/${x.sha}`)).content))));
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
// Korean-prose token count (억/만) instead of the English B/M shorthand.
const tokKr = (n) => (n >= 1e8 ? `${Math.round(n / 1e8)}억` : `${Math.round(n / 1e4)}만`);
const mon = (p) => Number(p.slice(5, 7)) + '월';
const day = (p) => Number(p.slice(8, 10));
const dateKr = (p) => `${mon(p)} ${day(p)}일`;

// Historical USD→KRW rate for one date (ECB reference rate via Frankfurter).
// Network hiccups must never block the note: fall back to no parenthetical.
async function fxRate(dateStr) {
  try {
    const res = await fetch(`https://api.frankfurter.app/${dateStr}?from=USD&to=KRW`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.rates?.KRW === 'number' ? data.rates.KRW : null;
  } catch {
    return null;
  }
}
const rate = await fxRate(last);
const peakRate = peak.period === last ? rate : await fxRate(peak.period);
const krw = (n, r) => (r ? ` (₩${Math.round(n * r).toLocaleString('en-US')})` : '');
// usd() amount plus its day's KRW equivalent in parentheses; defaults to the note's
// reference-date rate, with peakRate passed explicitly for the single-day record.
const usdWon = (n, r = rate) => `${usd(n)}${krw(n, r)}`;
const part = (p) => { const d = day(p); return d <= 10 ? '초' : d <= 20 ? ' 중순' : ' 말'; };
// '으로'/'로' depends on the batchim of the number's last spoken syllable. In this
// range (dollars, no cents) a units digit of 0/1/3/6/7/8 always lands on a batchim
// syllable (직접 자릿수 또는 십/백/천/만 같은 자릿수 단위 모두 받침으로 끝난다).
const josa = (n) => ([0, 1, 3, 6, 7, 8].includes(Math.abs(Math.round(n)) % 10) ? '으로' : '로');
const daysInMonth = (p) => new Date(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0).getDate();
const monthKr = (p) => (p === last.slice(0, 7) && day(last) < daysInMonth(p) ? `${mon(p)}(${day(last)}일까지)` : mon(p));
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

// 연결어미('-고') 뒤에는 쉼표를 두지 않는다(humanizer COMMA_CONN 규칙) — 두 문장으로 끊는다.
const topModelShare = topModel[1] / cost > 0.4 ? '절반 가까이 차지한다' : '가장 많다';
const currentMonth = last.slice(0, 7);
const currentCost = months.get(currentMonth) || 0;
const isCurrentPeak = peakMonth[0] === currentMonth;
const monthFlow = lastFull
  ? isCurrentPeak
    ? `${mon(lastFull[0])}은 ${usdWon(lastFull[1])}였다. ${monthKr(currentMonth)}은 ${usdWon(currentCost)}${josa(currentCost)} 가장 많다.`
    : `${mon(lastFull[0])}은 ${usdWon(lastFull[1])}였다. ${monthKr(currentMonth)}은 ${usdWon(currentCost)}이다. 월 최고 기록은 ${mon(peakMonth[0])}의 ${usdWon(peakMonth[1])}이다.`
  : `${monthKr(currentMonth)}이 ${usdWon(currentCost)}${josa(currentCost)} 가장 많다.`;

const usageNote = `### 사용량 노트 <sub>${last} 기준</sub>

${mon(first)}${part(first)}부터 ${span()} 달 동안 AI 코딩 도구로 ${tokKr(tokens)} 토큰을 썼다. API 정가로 환산한 비용은 ${usdWon(cost)}${josa(cost)}, 정액 구독(Claude Max 등) 요금제라면 실제 결제액은 이보다 적다. 전체 토큰의 ${(cacheRead / tokens * 100).toFixed(1)}%를 캐시에서 읽었다.

도구별로는 ${tool1[0]} ${usdWon(tool1[1])}, ${tool2[0]} ${usdWon(tool2[1])} 순으로 ${tool1[0]}가 ${tool2[0]}의 ${(tool1[1] / tool2[1]).toFixed(1)}배다. Gemini는 ${gemini > 0 ? `약 ${usdWon(gemini)}이다` : '쓰지 않았다'}. 모델별로는 ${topModel[0]}가 ${usdWon(topModel[1])}${josa(topModel[1])} ${topModelShare}. Claude 쪽은 ${claudeTop[0]}가 ${usdWon(claudeTop[1])}이다.

월별로는 ${monthFlow} 하루 최고 기록은 ${dateKr(peak.period)}의 ${usdWon(peak.totalCost, peakRate)}이다. 최근 30일 기준으로도 ${rec1[0]} ${usdWon(rec1[1])}, ${rec2[0]} ${usdWon(rec2[1])}${josa(rec2[1])} 도구별 순위는 ${rec1[0] === tool1[0] ? '동일하다' : '달라졌다'}.
`;

const { note, insights } = await buildEnrichedNote(usageNote);
if (DRY_RUN) { console.log(note); process.exit(0); }

const meta = await api(`repos/${REPO}/contents/README.md`);
const readme = b64(meta.content);
const next = replaceUsageNote(readme, note);
if (next === readme) { console.log(`[note] no change`); process.exit(0); }

const payload = JSON.stringify({
  message: `Update usage note: ${tok(tokens)} tokens, ${usd(cost)}`,
  content: Buffer.from(next, 'utf8').toString('base64'),
  sha: meta.sha,
});
// Send JSON directly so currency strings are never expanded by a shell.
await api(`repos/${REPO}/contents/README.md`, { method: 'PUT', body: payload });
console.log(`[note] updated: ${tok(tokens)} tokens, ${usd(cost)}, ${insights.insights.length} curation insights, humanizer checks passed`);
