import { execFileSync } from 'node:child_process';

// Scheduled jobs must not depend on whichever account is active in the shell.
// Resolve the configured account without changing gh's global active account.
export function createGitHubClient({
  repo,
  username = process.env.USAGE_CARD_GITHUB_USER || repo?.split('/')[0],
  gh = process.env.GH_PATH ?? (process.platform === 'win32' ? 'gh.exe' : 'gh'),
  exec = execFileSync,
  fetchImpl = fetch,
} = {}) {
  if (!repo || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo))
    throw new Error('Set USAGE_CARD_REPO to owner/repository');
  if (!username || !/^[a-z0-9][a-z0-9-]*$/i.test(username))
    throw new Error('Set USAGE_CARD_GITHUB_USER to the GitHub account that can write to the repository');

  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  let token;
  try {
    token = exec(gh, ['auth', 'token', '--hostname', 'github.com', '--user', username], {
      encoding: 'utf8', windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`GitHub account ${username} is unavailable. Log in with gh auth login --hostname github.com.`);
  }
  if (!token) throw new Error(`GitHub account ${username} returned an empty credential`);

  const api = async (path, opts = {}) => {
    const response = await fetchImpl(`https://api.github.com/${path}`, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...opts.headers,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok)
      throw new Error(`GitHub ${opts.method || 'GET'} ${path} failed (${response.status}) as ${username}; check repository access`);
    return response.json();
  };

  const assertWriteAccess = async () => {
    const metadata = await api(`repos/${repo}`);
    if (metadata.archived || metadata.permissions?.push !== true)
      throw new Error(`GitHub account ${username} cannot write to ${repo}; check USAGE_CARD_GITHUB_USER and repository permissions`);
  };
  return { api, assertWriteAccess };
}
