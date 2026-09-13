import fs from 'node:fs/promises';

const USER = process.env.GITHUB_USER || 'MrHakan';
const TOKEN = process.env.GITHUB_TOKEN;
const API = 'https://api.github.com';

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, { retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(`${API}${path}`, { headers });
    if (res.status === 202 && attempt < retries) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
    return res.json();
  }
  throw new Error(`Stats not ready: ${path}`);
}

async function allRepos() {
  const repos = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api(`/users/${USER}/repos?type=owner&sort=updated&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((repo) => !repo.fork && !repo.archived && !repo.disabled);
}

function safeSum(values) {
  return values.reduce((a, b) => a + (Number(b) || 0), 0);
}

async function repoStats(repo) {
  const encoded = `${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
  const [commitActivity, codeFrequency, contributors] = await Promise.allSettled([
    api(`/repos/${encoded}/stats/commit_activity`),
    api(`/repos/${encoded}/stats/code_frequency`),
    api(`/repos/${encoded}/stats/contributors`),
  ]);

  const weeks = commitActivity.status === 'fulfilled' && Array.isArray(commitActivity.value) ? commitActivity.value : [];
  const code = codeFrequency.status === 'fulfilled' && Array.isArray(codeFrequency.value) ? codeFrequency.value : [];
  const contributorRows = contributors.status === 'fulfilled' && Array.isArray(contributors.value) ? contributors.value : [];

  const commits52 = safeSum(weeks.slice(-52).map((w) => w.total));
  const commits12 = safeSum(weeks.slice(-12).map((w) => w.total));
  const additions52 = safeSum(code.slice(-52).map((w) => Math.max(0, w[1] || 0)));
  const deletions52 = safeSum(code.slice(-52).map((w) => Math.abs(Math.min(0, w[2] || 0))));
  const lifetimeCommits = safeSum(contributorRows.map((c) => c.total));
  const activeWeeks = weeks.slice(-52).filter((w) => (w.total || 0) > 0).length;
  const peakWeek = weeks.slice(-52).reduce((best, w) => (w.total || 0) > (best.total || 0) ? w : best, { total: 0, week: null });
  const ageDays = Math.max(1, Math.round((Date.now() - new Date(repo.created_at).getTime()) / 86400000));

  return {
    name: repo.name,
    url: repo.html_url,
    description: repo.description,
    language: repo.language || 'Unspecified',
    createdAt: repo.created_at,
    pushedAt: repo.pushed_at,
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    openIssues: repo.open_issues_count || 0,
    sizeKb: repo.size || 0,
    commits52,
    commits12,
    lifetimeCommits,
    additions52,
    deletions52,
    churn52: additions52 + deletions52,
    activeWeeks,
    consistency: Math.round((activeWeeks / 52) * 100),
    peakWeekCommits: peakWeek.total || 0,
    peakWeekStart: peakWeek.week ? new Date(peakWeek.week * 1000).toISOString() : null,
    commitsPer30DaysOfAge: Number(((lifetimeCommits / ageDays) * 30).toFixed(2)),
    netLines52: additions52 - deletions52,
    weeks: weeks.slice(-52).map((w) => ({ week: w.week, total: w.total || 0 })),
    codeFrequency: code.slice(-52).map((w) => ({ week: w[0], additions: Math.max(0, w[1] || 0), deletions: Math.abs(Math.min(0, w[2] || 0)) })),
  };
}

const repos = await allRepos();
const results = [];
const concurrency = 4;
for (let i = 0; i < repos.length; i += concurrency) {
  const slice = repos.slice(i, i + concurrency);
  const batch = await Promise.all(slice.map(async (repo) => {
    try { return await repoStats(repo); }
    catch (error) {
      console.warn(`Skipping deep stats for ${repo.name}: ${error.message}`);
      return {
        name: repo.name, url: repo.html_url, description: repo.description, language: repo.language || 'Unspecified',
        createdAt: repo.created_at, pushedAt: repo.pushed_at, stars: repo.stargazers_count || 0,
        forks: repo.forks_count || 0, openIssues: repo.open_issues_count || 0, sizeKb: repo.size || 0,
        commits52: 0, commits12: 0, lifetimeCommits: 0, additions52: 0, deletions52: 0, churn52: 0,
        activeWeeks: 0, consistency: 0, peakWeekCommits: 0, peakWeekStart: null,
        commitsPer30DaysOfAge: 0, netLines52: 0, weeks: [], codeFrequency: [],
      };
    }
  }));
  results.push(...batch);
}

const totals = {
  repos: results.length,
  commits52: safeSum(results.map((r) => r.commits52)),
  lifetimeCommits: safeSum(results.map((r) => r.lifetimeCommits)),
  additions52: safeSum(results.map((r) => r.additions52)),
  deletions52: safeSum(results.map((r) => r.deletions52)),
  churn52: safeSum(results.map((r) => r.churn52)),
};

await fs.mkdir('data', { recursive: true });
await fs.writeFile('data/stats.json', JSON.stringify({ generatedAt: new Date().toISOString(), user: USER, totals, repos: results }, null, 2));
console.log(`Generated deep stats for ${results.length} repositories.`);
