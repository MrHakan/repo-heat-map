import fs from 'node:fs/promises';

const USER = process.env.GITHUB_USER || 'MrHakan';
const TOKEN = process.env.GITHUB_TOKEN;
const API = 'https://api.github.com';
const GRAPHQL = 'https://api.github.com/graphql';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NOW = Date.now();
const SINCE_52W_MS = NOW - (52 * WEEK_MS);
const SINCE_12W_MS = NOW - (12 * WEEK_MS);
const SINCE_52W = new Date(SINCE_52W_MS).toISOString();
const MAX_HISTORY_PAGES = 50;

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
  return res.json();
}

async function graphql(query, variables) {
  if (!TOKEN) throw new Error('GraphQL requires GITHUB_TOKEN');
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
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

const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);

function emptyWeeks() {
  return Array.from({ length: 52 }, (_, index) => ({
    week: Math.floor((SINCE_52W_MS + (index * WEEK_MS)) / 1000),
    total: 0,
    additions: 0,
    deletions: 0,
  }));
}

function bucketIndex(committedDate) {
  const ms = new Date(committedDate).getTime();
  if (!Number.isFinite(ms)) return -1;
  return Math.min(51, Math.max(0, Math.floor((ms - SINCE_52W_MS) / WEEK_MS)));
}

async function historyStats(repo) {
  const query = `
    query RepoHistory($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef {
          target {
            ... on Commit {
              lifetime: history(first: 1) { totalCount }
              recent: history(first: 100, since: $since, after: $after) {
                totalCount
                nodes {
                  committedDate
                  additions
                  deletions
                  changedFilesIfAvailable
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
    }
  `;

  const weeks = emptyWeeks();
  let after = null;
  let page = 0;
  let hasNextPage = false;
  let commits52 = 0;
  let lifetimeCommits = 0;
  let additions52 = 0;
  let deletions52 = 0;
  let fileTouches52 = 0;
  let fileTouchCommitCount52 = 0;
  let commits12 = 0;
  let seenCommits = 0;

  do {
    const result = await graphql(query, {
      owner: repo.owner.login,
      name: repo.name,
      since: SINCE_52W,
      after,
    });

    const target = result?.repository?.defaultBranchRef?.target;
    const recent = target?.recent;
    if (!recent) break;

    if (page === 0) {
      commits52 = Number(recent.totalCount) || 0;
      lifetimeCommits = Number(target?.lifetime?.totalCount) || 0;
    }

    for (const commit of recent.nodes || []) {
      seenCommits += 1;
      additions52 += Number(commit.additions) || 0;
      deletions52 += Number(commit.deletions) || 0;

      const committedMs = new Date(commit.committedDate).getTime();
      if (committedMs >= SINCE_12W_MS) commits12 += 1;

      if (Number.isFinite(commit.changedFilesIfAvailable)) {
        fileTouches52 += commit.changedFilesIfAvailable;
        fileTouchCommitCount52 += 1;
      }

      const index = bucketIndex(commit.committedDate);
      if (index >= 0) {
        weeks[index].total += 1;
        weeks[index].additions += Number(commit.additions) || 0;
        weeks[index].deletions += Number(commit.deletions) || 0;
      }
    }

    hasNextPage = Boolean(recent.pageInfo?.hasNextPage);
    after = recent.pageInfo?.endCursor || null;
    page += 1;
  } while (hasNextPage && after && page < MAX_HISTORY_PAGES);

  const historyCapped = hasNextPage && page >= MAX_HISTORY_PAGES;
  const activeWeeks = weeks.filter((week) => week.total > 0).length;
  const peakWeek = weeks.reduce((best, week) => week.total > best.total ? week : best, weeks[0]);
  const churn52 = additions52 + deletions52;

  return {
    commits52,
    commits12,
    lifetimeCommits,
    additions52,
    deletions52,
    churn52,
    fileTouches52,
    fileTouchCommitCount52,
    fileCoverage52: commits52 ? Number(((fileTouchCommitCount52 / Math.min(commits52, seenCommits || commits52)) * 100).toFixed(1)) : 100,
    historyCapped,
    filesPerCommit52: fileTouchCommitCount52 ? Number((fileTouches52 / fileTouchCommitCount52).toFixed(2)) : 0,
    linesPerCommit52: seenCommits ? Number((churn52 / seenCommits).toFixed(2)) : 0,
    activeWeeks,
    consistency: Math.round((activeWeeks / 52) * 100),
    peakWeekCommits: peakWeek?.total || 0,
    peakWeekStart: peakWeek ? new Date(peakWeek.week * 1000).toISOString() : null,
    netLines52: additions52 - deletions52,
    weeks: weeks.map(({ week, total }) => ({ week, total })),
    codeFrequency: weeks.map(({ week, additions, deletions }) => ({ week, additions, deletions })),
    seenCommits52: seenCommits,
  };
}

async function repoStats(repo) {
  const stats = await historyStats(repo);
  const ageDays = Math.max(1, Math.round((NOW - new Date(repo.created_at).getTime()) / 86400000));

  if (!stats.historyCapped && stats.seenCommits52 !== stats.commits52) {
    throw new Error(`history count mismatch: expected ${stats.commits52}, received ${stats.seenCommits52}`);
  }
  if (stats.lifetimeCommits < stats.commits52) {
    throw new Error(`lifetime commits ${stats.lifetimeCommits} < 52w commits ${stats.commits52}`);
  }
  if (stats.fileTouchCommitCount52 > stats.seenCommits52) {
    throw new Error('changed-files coverage exceeds fetched commit count');
  }

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
    ...stats,
    commitsPer30DaysOfAge: Number(((stats.lifetimeCommits / ageDays) * 30).toFixed(2)),
    analyticsSource: 'github-graphql-default-branch-history',
    analyticsError: null,
  };
}

const repos = await allRepos();
const results = [];
const concurrency = 3;
for (let i = 0; i < repos.length; i += concurrency) {
  const slice = repos.slice(i, i + concurrency);
  const batch = await Promise.all(slice.map(async (repo) => {
    try {
      return await repoStats(repo);
    } catch (error) {
      console.warn(`Analytics unavailable for ${repo.name}: ${error.message}`);
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
        commits52: 0,
        commits12: 0,
        lifetimeCommits: 0,
        additions52: 0,
        deletions52: 0,
        churn52: 0,
        fileTouches52: 0,
        fileTouchCommitCount52: 0,
        fileCoverage52: 0,
        historyCapped: false,
        filesPerCommit52: 0,
        linesPerCommit52: 0,
        activeWeeks: 0,
        consistency: 0,
        peakWeekCommits: 0,
        peakWeekStart: null,
        netLines52: 0,
        weeks: [],
        codeFrequency: [],
        seenCommits52: 0,
        commitsPer30DaysOfAge: 0,
        analyticsSource: 'github-graphql-default-branch-history',
        analyticsError: error.message,
      };
    }
  }));
  results.push(...batch);
}

const valid = results.filter((repo) => !repo.analyticsError);
const totals = {
  repos: results.length,
  reposWithAnalytics: valid.length,
  commits52: sum(valid.map((repo) => repo.commits52)),
  lifetimeCommits: sum(valid.map((repo) => repo.lifetimeCommits)),
  additions52: sum(valid.map((repo) => repo.additions52)),
  deletions52: sum(valid.map((repo) => repo.deletions52)),
  churn52: sum(valid.map((repo) => repo.churn52)),
  fileTouches52: sum(valid.map((repo) => repo.fileTouches52)),
};

const quality = {
  source: 'GitHub GraphQL default-branch linear commit history',
  scope: 'Non-fork, non-archived, public repositories owned by the account',
  window: 'Rolling 52 weeks from generation time',
  generatedRepoCount: results.length,
  validRepoCount: valid.length,
  errorRepoCount: results.length - valid.length,
  changedFilesCoveragePercent: sum(valid.map((repo) => repo.commits52))
    ? Number(((sum(valid.map((repo) => repo.fileTouchCommitCount52)) / sum(valid.map((repo) => repo.commits52))) * 100).toFixed(1))
    : 100,
  notes: [
    'Only commits reachable from each repository default branch are counted.',
    'Commits that exist only on unmerged branches are intentionally excluded.',
    'Changed-file averages exclude commits where GitHub returns changedFilesIfAvailable as null.',
    'Additions and deletions use GitHub commit-level GraphQL values.',
  ],
};

await fs.mkdir('data', { recursive: true });
await fs.writeFile('data/stats.json', JSON.stringify({ generatedAt: new Date().toISOString(), user: USER, totals, quality, repos: results }, null, 2));
console.log(`Generated canonical GraphQL analytics for ${valid.length}/${results.length} repositories.`);
