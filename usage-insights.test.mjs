import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectCurations, validateInsights, replaceUsageNote, buildEnrichedNote, renderInsights, parseInsights, stripListMarkers, validatePolishedInsights, validateReview } from './usage-insights.mjs';

const origin = 'https://datanexus-kr.github.io';
const excerpt = '비용 최적화는 반복 입력, 누적 컨텍스트, 호출 수를 따로 측정하는 데서 시작합니다.';
const page = (slug, title = '토큰 비용 관리') => ({
  permalink: `${origin}/curations/${slug.slice(0, 7)}/${slug}/`, title, summary: '', content: excerpt.repeat(6),
});
const sources = selectCurations([page('2026-09-04-cost'), page('2026-09-02-cache')], { today: '2026-09-05' });
const note = '### 사용량 노트 <sub>2026-09-05 기준</sub>\n\nAPI 정가 환산액은 $100이며 실제 결제액과는 다르다. 캐시에서 읽은 토큰은 90%다.\n';
const valid = () => ({ format: 'numbered', insights: sources.map((s) => ({
  paragraph: `캐시에서 읽은 토큰은 90%다. [비용 관리 큐레이션](${s.url})에서 설명한 반복 입력과 호출 수를 나눠 살펴볼 필요가 있다. 현재 집계에는 완료 작업 수와 재시도가 없어 실제 절감 효과까지 판단하기는 어렵다.`,
  evidence: [{ url: s.url, excerpt }],
})) });

test('selects recent published cost articles; excludes future, foreign and non-curation pages', () => {
  const items = [page('2026-09-04-cost'), page('2026-09-02-cache'), page('2026-09-06-future'),
    { ...page('2026-09-05-foreign'), permalink: 'https://example.org/curations/2026-09/2026-09-05-foreign/' },
    { ...page('2026-09-05-post'), permalink: `${origin}/posts/2026-09/2026-09-05-post/` },
    page('2026-09-05-unrelated', '데이터 모델링'), page('2026-09-04-cost')];
  const result = selectCurations(items, { today: '2026-09-05' });
  assert.deepEqual(result.map((s) => s.date), ['2026-09-04', '2026-09-02']);
  assert.throws(() => selectCurations([items[0]], { today: '2026-09-05' }), /At least two/);
});

test('new cost articles enter the next run without editing a source allowlist', () => {
  const result = selectCurations([page('2026-09-05-new-cost'), ...sources.map((s) => ({ ...s, permalink: s.url }))], { today: '2026-09-05', limit: 2 });
  assert.equal(result[0].date, '2026-09-05');
});

test('accepts linked evidence actually present in two source articles', () => {
  assert.doesNotThrow(() => validateInsights(valid(), sources, note));
});

test('rejects fabricated evidence, unapproved links and invented quantitative claims', () => {
  const fabricated = valid();
  fabricated.insights[0].evidence[0].excerpt = '실제 본문에는 없는 내용으로 비용이 크게 줄었다고 주장하는 문장입니다.';
  assert.throws(() => validateInsights(fabricated, sources, note), /excerpt/);
  const foreign = valid();
  foreign.insights[0].paragraph += ' [다른 링크](https://example.com/)';
  assert.throws(() => validateInsights(foreign, sources, note), /Unverified/);
  const number = valid();
  number.insights[0].paragraph = number.insights[0].paragraph.replace('90%', '87%');
  assert.throws(() => validateInsights(number, sources, note), /number outside/);
  const verbose = valid();
  verbose.insights[0].paragraph += ' 같은 한계를 다시 설명한다.';
  assert.throws(() => validateInsights(verbose, sources, note), /2-3 sentences/);
});

test('legacy migration and repeated updates preserve profile content outside the note', () => {
  const before = '## Hi there\n\n<img src="card.svg" />\n\n';
  const after = '## Projects\n\nMy project\n';
  const old = `${before}### 사용량 노트 <sub>어제</sub>\n\nOld note\n\n${after}`;
  const first = replaceUsageNote(old, note + '\n#### 비용 인사이트\n\nInsights\n');
  const second = replaceUsageNote(first, note + '\n#### 비용 인사이트\n\nNew insights\n');
  assert.ok(second.startsWith(before));
  assert.ok(second.endsWith(after));
  assert.equal((second.match(/usage-note:start/g) || []).length, 1);
  assert.equal((second.match(/#### 비용 인사이트/g) || []).length, 1);
  assert.ok(!second.includes('Old note'));
  assert.ok(!second.includes('\nInsights\n'));
});

test('a half-written note is rebuilt instead of wedging every later run', () => {
  const before = '## Hi there\n\n<img src="card.svg" />\n\n';
  const good = replaceUsageNote(`${before}### 사용량 노트 <sub>어제</sub>\n\nOld note\n`, note);
  // An older generator left a stray start marker / dropped the end marker; the
  // next run must recover rather than throw, and must not stack up markers.
  for (const broken of [
    good + '<!-- usage-note:start -->',
    good.replace('<!-- usage-note:end -->', ''),
  ]) {
    const fixed = replaceUsageNote(broken, note);
    assert.equal((fixed.match(/usage-note:start/g) || []).length, 1);
    assert.equal((fixed.match(/usage-note:end/g) || []).length, 1);
    assert.ok(fixed.startsWith(before));
    // and it stays stable on the run after that
    const again = replaceUsageNote(fixed, note);
    assert.equal((again.match(/usage-note:start/g) || []).length, 1);
    assert.equal((again.match(/usage-note:end/g) || []).length, 1);
  }
});

test('failed source collection stops generation and leaves the prior result alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-insights-test-'));
  try {
    mkdirSync(join(dir, 'references'));
    writeFileSync(join(dir, 'SKILL.md'), 'Test skill');
    writeFileSync(join(dir, 'references/citation.md'), 'Test citation rule');
    let calls = 0;
    await assert.rejects(buildEnrichedNote(note, { skillDir: dir, outDir: dir,
      fetchImpl: async () => ({ ok: false, status: 503 }), writer: () => { calls++; },
    }), /index failed: 503/);
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const format of ['paragraphs', 'bullets', 'numbered']) {
  test(`${format}: render, parse, polish, audit and reuse validated cache`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-insights-test-'));
    const input = valid();
    input.format = format;
    const rendered = renderInsights(input);
    assert.deepEqual(parseInsights(rendered).insights.map((x) => x.paragraph), input.insights.map((x) => x.paragraph));
    let calls = 0;
    const options = { outDir: dir,
      fetchImpl: async () => ({ ok: true, json: async () => sources.map((s) => ({ ...s, permalink: s.url })) }),
      writer: async (_system, data) => {
        calls++;
        if (data.final) return JSON.stringify({ approved: true, issues: [] });
        if (data.draft) return data.draft;
        return JSON.stringify(input);
      },
    };
    try {
      const result = await buildEnrichedNote(note, options);
      assert.ok(result.note.startsWith(note.trim() + '\n\n'));
      assert.equal(result.insights.format, format);
      assert.deepEqual(result.checks.preserved.lost, {});
      assert.deepEqual(result.checks.preserved.added, {});
      assert.equal(calls, 3);
      const cached = await buildEnrichedNote(note, options);
      assert.equal(cached.note, result.note);
      assert.equal(calls, 3);
      const changed = await buildEnrichedNote(note.replace('$100', '$101'), options);
      assert.ok(changed.note.includes('$101'));
      assert.equal(calls, 6, 'changed daily usage must regenerate and review');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('only list markers are stripped; real numbers and units are still protected', () => {
  assert.equal(stripListMarkers('1. $100, 90%, 30일\n2. gpt-5.5\n3. 2배'), '$100, 90%, 30일\ngpt-5.5\n2배');
  const input = valid();
  const draft = note.trim() + '\n\n#### 비용 인사이트\n\n' + renderInsights(input) + '\n';
  const check = (final) => validatePolishedInsights(draft, final, input, sources, note);
  assert.doesNotThrow(() => check(draft));
  assert.throws(() => check(draft.replace('1. ', '9. ')), /consecutive|format/);
  assert.throws(() => check(draft.replace('1. ', '- ')), /flat bullets/);
  assert.throws(() => check(draft.replace('캐시에서 읽은 토큰은 90%다. [', '캐시에서 읽은 토큰은 100%다. [')), /protected/);
  assert.throws(() => check(draft.replace('캐시에서 읽은 토큰은 90%다. [', '캐시에서 읽은 토큰은 90%다. 2배 늘었다. [')), /protected/);
  assert.throws(() => check(draft.replace('$100', '$101')), /summary/);
  for (const quantity of ['$90', '100%']) {
    const changed = valid();
    changed.insights[0].paragraph = changed.insights[0].paragraph.replace('90%', quantity);
    assert.throws(() => validateInsights(changed, sources, note), /amount, percentage or unit/);
  }
  const noEvidence = valid();
  noEvidence.insights[0].evidence = [];
  assert.throws(() => validateInsights(noEvidence, sources, note), /Missing curation evidence/);
});

test('rejects absent, incomplete and negative semantic reviews', () => {
  for (const review of [null, {}, { approved: true }, { approved: true, issues: ['Unsupported'] }, { approved: false, issues: [] }])
    assert.throws(() => validateReview(review), /Unsupported/);
});

test('keeps conclusions short and rejects summary-sized items and dense statistics', () => {
  const longConclusion = valid();
  longConclusion.insights[0].paragraph = '같은 내용을 반복해서 모델에게 보내는 경우가 많은데 지금 집계만으로는 어떤 작업이 그 원인인지 알 수 없다. [비용 관리 큐레이션](' + sources[0].url + ')을 참고할 수 있다.';
  assert.throws(() => validateInsights(longConclusion, sources, note), /short conclusion/);
  const longItem = valid();
  longItem.insights[0].paragraph += ' 설명이 반복되면 독자는 핵심을 이해하기 어려우므로 반복 설명을 줄이고 한 번만 짧고 쉽게 설명하는 편이 좋다.';
  assert.throws(() => validateInsights(longItem, sources, note), /short text item/);
  const dense = valid();
  dense.insights[0].paragraph = dense.insights[0].paragraph.replace('90%다', '90%이며 $100이고 30일 기준이다');
  assert.throws(() => validateInsights(dense, sources, note + ' 30일'), /at most two/);
});

test('unsupported qualitative claims cannot replace a previously validated cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-insights-test-'));
  const cachePath = join(dir, 'usage-note-cache.json');
  const prior = JSON.stringify({ hash: 'prior', note: 'previous published note' });
  writeFileSync(cachePath, prior);
  try {
    await assert.rejects(buildEnrichedNote(note, { outDir: dir,
      fetchImpl: async () => ({ ok: true, json: async () => sources.map((s) => ({ ...s, permalink: s.url })) }),
      writer: async (_system, data) => {
        if (data.final) return JSON.stringify({ approved: false, issues: ['Item 1: excerpt does not support the claim'] });
        if (data.draft) return data.draft;
        return JSON.stringify(valid());
      },
    }), /Unsupported insight claims/);
    assert.equal(readFileSync(cachePath, 'utf8'), prior);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('overlong generated insights receive item length and the failed draft for repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-insights-repair-test-'));
  const overlong = valid();
  overlong.insights[0].paragraph += ' 반복 설명을 삭제하고 짧게 고쳐야 한다.'.repeat(4);
  const serialized = JSON.stringify(overlong);
  const length = overlong.insights[0].paragraph.replace(/https?:\/\/[^\s)<>]+/g, '').length;
  let draftCalls = 0;
  try {
    const result = await buildEnrichedNote(note, { outDir: dir,
      fetchImpl: async () => ({ ok: true, json: async () => sources.map((s) => ({ ...s, permalink: s.url })) }),
      writer: async (system, data) => {
        if (data.final) return JSON.stringify({ approved: true, issues: [] });
        if (data.draft) return data.draft;
        draftCalls++;
        if (draftCalls === 1) return serialized;
        assert.equal(data.previousResult, serialized);
        assert.match(data.repair, new RegExp(`Insight 1.*got ${length}`));
        assert.match(data.repair, /80-120/);
        assert.match(system, /previousResult/);
        return JSON.stringify(valid());
      },
    });
    assert.equal(draftCalls, 2);
    assert.ok(result.review.approved);
    assert.ok(!result.note.includes('반복 설명을 삭제'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
