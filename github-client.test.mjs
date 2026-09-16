import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClient } from './github-client.mjs';

const repo = 'profile-owner/profile-owner';
const ok = (value) => ({ ok: true, json: async () => value });

test('pins the stored account for reads and writes despite inherited credentials', async () => {
  const previous = process.env.GH_TOKEN;
  const previousGithub = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = 'unrelated-active-account';
  process.env.GITHUB_TOKEN = 'unrelated-environment-token';
  const requests = [];
  try {
    const client = createGitHubClient({
      repo, username: 'profile-owner',
      exec: (file, args, options) => {
        assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com', '--user', 'profile-owner']);
        assert.equal(options.env.GH_TOKEN, undefined);
        assert.equal(options.env.GITHUB_TOKEN, undefined);
        return 'selected-account-token\n';
      },
      fetchImpl: async (url, options) => {
        requests.push([url, options]);
        return ok({ permissions: { push: true } });
      },
    });
    await client.assertWriteAccess();
    await client.api(`repos/${repo}/git/trees`, { method: 'POST', body: '{"tree":[]}' });
    await client.api(`repos/${repo}/contents/README.md`, { method: 'PUT', body: '{"message":"$9,635"}' });
    assert.equal(requests.length, 3);
    for (const [, options] of requests)
      assert.equal(options.headers.Authorization, 'Bearer selected-account-token');
    assert.equal(requests[2][1].body, '{"message":"$9,635"}');
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous;
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousGithub;
  }
});

test('a read-only or archived repository fails preflight before publication', async () => {
  for (const metadata of [{ permissions: { push: false } }, { archived: true, permissions: { push: true } }, {}]) {
    const client = createGitHubClient({ repo, exec: () => 'token', fetchImpl: async () => ok(metadata) });
    await assert.rejects(client.assertWriteAccess(), /cannot write.*repository permissions/);
  }
});

test('missing selected account never falls back to the active account or exposes credentials', () => {
  let calls = 0;
  assert.throws(() => createGitHubClient({ repo, exec: () => {
    calls++;
    throw new Error('sensitive-subprocess-output');
  } }), { message: /account .* is unavailable/ });
  assert.equal(calls, 1);
});

test('API errors identify the account, method and operation without exposing the response body', async () => {
  const client = createGitHubClient({ repo, username: 'profile-owner', exec: () => 'token', fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(client.api(`repos/${repo}/git/trees`, { method: 'POST' }),
    /GitHub POST .*git\/trees failed \(404\) as profile-owner/);
});

test('empty credentials fail before any API call', () => {
  assert.throws(() => createGitHubClient({ repo, exec: () => ' \n' }), /empty credential/);
});
