import fs from 'node:fs/promises';

const USER = process.env.GITHUB_USER || 'MrHakan';
const TOKEN = process.env.GITHUB_TOKEN;
const API = 'https://api.github.com';
const GRAPHQL = 'https://api.github.com/graphql';
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const NOW = Date.now();
const SINCE_52W_MS = NOW - (52 * WEEK_MS);
const SINCE_12W_MS = NOW - (12 * WEEK_MS);
const SINCE_52W = new Date(SINCE_52W_MS).toISOString();
const MAX_HISTORY_PAGES = 50;
const TYPE_KEYS = ['feat','fix','docs','chore','refactor','test','style','perf','build','ci','revert','merge','other'];
const SIZE_LABELS = ['0–9','10–49','50–199','200–999','1k–9.9k','10k+'];

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
const emptyArray = (n) => Array.from({ length: n }, () => 0);
const emptyTypeCounts = () => Object.fromEntries(TYPE_KEYS.map((key) => [key, 0]));
const ageDays = (date) => Math.max(0, Math.floor((NOW - new Date(date).getTime()) / DAY_MS));

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

function sizeBucket(lines) {
  if (lines < 10) return 0;
  if (lines < 50) return 1;
  if (lines < 200) return 2;
  if (lines < 1000) return 3;
  if (lines < 10000) return 4;
  return 5;
}

function commitType(message, isMerge) {
  if (isMerge || /^merge\b/i.test(message || '')) return 'merge';
  const match = String(message || '').toLowerCase().match(/^(feat|fix|docs|chore|refactor|test|tests|style|perf|build|ci|revert)(?:\([^)]*\))?!?:/);
  if (!match) return 'other';
  return match[1] === 'tests' ? 'test' : match[1];
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function longestDayStreak(dayKeys) {
  const days = [...new Set(dayKeys)].map((v) => Date.parse(`${v}T00:00:00Z`)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!days.length) return 0;
  let longest = 1;
  let current = 1;
  for (let i = 1; i < days.length; i += 1) {
    if (days[i] - days[i - 1] === DAY_MS) current += 1;
    else current = 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

async function repoMetadata(repo) {
  const query = `
    query RepoMeta($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef { name }
        heads: refs(refPrefix: "refs/heads/", first: 100) {
          totalCount
          nodes {
            name
            target { ... on Commit { oid committedDate } }
          }
        }
        tags: refs(refPrefix: "refs/tags/", first: 1) { totalCount }
        releases(first: 1) { totalCount nodes { tagName publishedAt createdAt } }
        openIssues: issues(states: OPEN) { totalCount }
        closedIssues: issues(states: CLOSED) { totalCount }
        openPRs: pullRequests(states: OPEN) { totalCount }
        mergedPRs: pullRequests(states: MERGED) { totalCount }
        closedPRs: pullRequests(states: CLOSED) { totalCount }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          totalSize
          edges { size node { name color } }
        }
      }
    }
  `;

  const result = await graphql(query, { owner: repo.owner.login, name: repo.name });
  const r = result?.repository;
  if (!r) throw new Error('repository metadata unavailable');

  const defaultBranch = r.defaultBranchRef?.name || repo.default_branch || 'main';
  const branches = (r.heads?.nodes || []).map((branch) => {
    const committedAt = branch.target?.committedDate || null;
    return {
      name: branch.name,
      oid: branch.target?.oid || null,
      committedAt,
      ageDays: committedAt ? ageDays(committedAt) : null,
      isDefault: branch.name === defaultBranch,
    };
  }).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (a.ageDays ?? 999999) - (b.ageDays ?? 999999));

  const branchCount = Number(r.heads?.totalCount) || 0;
  const branchSampleCapped = branchCount > branches.length;
  const activeBranches30d = branches.filter((b) => b.ageDays !== null && b.ageDays <= 30).length;
  const coolingBranches90d = branches.filter((b) => b.ageDays !== null && b.ageDays > 30 && b.ageDays <= 90).length;
  const staleBranches90d = branches.filter((b) => b.ageDays !== null && b.ageDays > 90).length;
  const mergedPRs = Number(r.mergedPRs?.totalCount) || 0;
  const closedPRs = Number(r.closedPRs?.totalCount) || 0;
  const decidedPRs = mergedPRs + closedPRs;

  return {
    defaultBranch,
    branchCount,
    branchSampleCapped,
    branchSampleCoverage: branchCount ? Number(((branches.length / branchCount) * 100).toFixed(1)) : 100,
    activeBranches30d,
    coolingBranches90d,
    staleBranches90d,
    branchSamples: branches.slice(0, 24),
    tagCount: Number(r.tags?.totalCount) || 0,
    releaseCount: Number(r.releases?.totalCount) || 0,
    latestRelease: r.releases?.nodes?.[0] || null,
    openIssues: Number(r.openIssues?.totalCount) || 0,
    closedIssues: Number(r.closedIssues?.totalCount) || 0,
    openPRs: Number(r.openPRs?.totalCount) || 0,
    mergedPRs,
    closedPRs,
    prMergeRate: decidedPRs ? Number(((mergedPRs / decidedPRs) * 100).toFixed(1)) : null,
    languages: (r.languages?.edges || []).map((edge) => ({
      name: edge.node?.name || 'Unknown',
      color: edge.node?.color || null,
      bytes: Number(edge.size) || 0,
    })),
    languageBytes: Number(r.languages?.totalSize) || 0,
  };
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
                  oid
                  committedDate
                  additions
                  deletions
                  changedFilesIfAvailable
                  messageHeadline
                  parents(first: 2) { totalCount }
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
  const commitHoursUtc = emptyArray(24);
  const commitDaysUtc = emptyArray(7);
  const commitTypeCounts = emptyTypeCounts();
  const commitSizeBuckets = emptyArray(SIZE_LABELS.length);
  const commitLineSizes = [];
  const commitDayKeys = [];
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
  let mergeCommits52 = 0;
  let conventionalCommits52 = 0;
  let weekendCommits52 = 0;
  let nightCommitsUtc52 = 0;
  let maxCommit52 = null;

  do {
    const result = await graphql(query, { owner: repo.owner.login, name: repo.name, since: SINCE_52W, after });
    const target = result?.repository?.defaultBranchRef?.target;
    const recent = target?.recent;
    if (!recent) break;

    if (page === 0) {
      commits52 = Number(recent.totalCount) || 0;
      lifetimeCommits = Number(target?.lifetime?.totalCount) || 0;
    }

    for (const commit of recent.nodes || []) {
      seenCommits += 1;
      const additions = Number(commit.additions) || 0;
      const deletions = Number(commit.deletions) || 0;
      const changedFiles = Number.isFinite(commit.changedFilesIfAvailable) ? commit.changedFilesIfAvailable : null;
      const lines = additions + deletions;
      const date = new Date(commit.committedDate);
      const hour = date.getUTCHours();
      const dow = date.getUTCDay();
      const isMerge = (Number(commit.parents?.totalCount) || 0) > 1;
      const type = commitType(commit.messageHeadline, isMerge);

      additions52 += additions;
      deletions52 += deletions;
      commitLineSizes.push(lines);
      commitSizeBuckets[sizeBucket(lines)] += 1;
      commitHoursUtc[hour] += 1;
      commitDaysUtc[dow] += 1;
      commitTypeCounts[type] += 1;
      if (isMerge) mergeCommits52 += 1;
      if (type !== 'merge' && type !== 'other') conventionalCommits52 += 1;
      if (dow === 0 || dow === 6) weekendCommits52 += 1;
      if (hour < 6) nightCommitsUtc52 += 1;
      commitDayKeys.push(commit.committedDate.slice(0, 10));

      if (!maxCommit52 || lines > maxCommit52.lines) {
        maxCommit52 = {
          oid: commit.oid,
          message: commit.messageHeadline || '(no message)',
          committedDate: commit.committedDate,
          lines,
          additions,
          deletions,
          changedFiles,
        };
      }

      const committedMs = date.getTime();
      if (committedMs >= SINCE_12W_MS) commits12 += 1;
      if (changedFiles !== null) {
        fileTouches52 += changedFiles;
        fileTouchCommitCount52 += 1;
      }

      const index = bucketIndex(commit.committedDate);
      if (index >= 0) {
        weeks[index].total += 1;
        weeks[index].additions += additions;
        weeks[index].deletions += deletions;
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
    medianLinesPerCommit52: percentile(commitLineSizes, 0.5),
    p95LinesPerCommit52: percentile(commitLineSizes, 0.95),
    activeWeeks,
    consistency: Math.round((activeWeeks / 52) * 100),
    peakWeekCommits: peakWeek?.total || 0,
    peakWeekStart: peakWeek ? new Date(peakWeek.week * 1000).toISOString() : null,
    netLines52: additions52 - deletions52,
    mergeCommits52,
    mergeShare52: seenCommits ? Number(((mergeCommits52 / seenCommits) * 100).toFixed(1)) : 0,
    conventionalCommits52,
    conventionalShare52: seenCommits ? Number(((conventionalCommits52 / seenCommits) * 100).toFixed(1)) : 0,
    weekendCommits52,
    weekendShare52: seenCommits ? Number(((weekendCommits52 / seenCommits) * 100).toFixed(1)) : 0,
    nightCommitsUtc52,
    nightShareUtc52: seenCommits ? Number(((nightCommitsUtc52 / seenCommits) * 100).toFixed(1)) : 0,
    longestDailyStreak52: longestDayStreak(commitDayKeys),
    maxCommit52,
    commitHoursUtc,
    commitDaysUtc,
    commitTypeCounts,
    commitSizeBuckets,
    weeks: weeks.map(({ week, total }) => ({ week, total })),
    codeFrequency: weeks.map(({ week, additions, deletions }) => ({ week, additions, deletions })),
    seenCommits52: seenCommits,
  };
}

function activityState(pushedAt) {
  const days = ageDays(pushedAt);
  if (days <= 30) return 'active';
  if (days <= 90) return 'cooling';
  return 'dormant';
}

async function repoStats(repo) {
  const [stats, meta] = await Promise.all([historyStats(repo), repoMetadata(repo)]);
  const repoAgeDays = Math.max(1, Math.round((NOW - new Date(repo.created_at).getTime()) / DAY_MS));

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
    sizeKb: repo.size || 0,
    activityState: activityState(repo.pushed_at),
    daysSincePush: ageDays(repo.pushed_at),
    ...meta,
    ...stats,
    commitsPer30DaysOfAge: Number(((stats.lifetimeCommits / repoAgeDays) * 30).toFixed(2)),
    analyticsSource: 'github-graphql-default-branch-history+repository-metadata',
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
        name: repo.name, url: repo.html_url, description: repo.description, language: repo.language || 'Unspecified',
        createdAt: repo.created_at, pushedAt: repo.pushed_at, stars: repo.stargazers_count || 0, forks: repo.forks_count || 0,
        sizeKb: repo.size || 0, activityState: activityState(repo.pushed_at), daysSincePush: ageDays(repo.pushed_at),
        defaultBranch: repo.default_branch || 'main', branchCount: 0, branchSampleCapped: false, branchSampleCoverage: 0,
        activeBranches30d: 0, coolingBranches90d: 0, staleBranches90d: 0, branchSamples: [], tagCount: 0, releaseCount: 0,
        latestRelease: null, openIssues: 0, closedIssues: 0, openPRs: 0, mergedPRs: 0, closedPRs: 0, prMergeRate: null,
        languages: [], languageBytes: 0, commits52: 0, commits12: 0, lifetimeCommits: 0, additions52: 0, deletions52: 0,
        churn52: 0, fileTouches52: 0, fileTouchCommitCount52: 0, fileCoverage52: 0, historyCapped: false,
        filesPerCommit52: 0, linesPerCommit52: 0, medianLinesPerCommit52: 0, p95LinesPerCommit52: 0, activeWeeks: 0,
        consistency: 0, peakWeekCommits: 0, peakWeekStart: null, netLines52: 0, mergeCommits52: 0, mergeShare52: 0,
        conventionalCommits52: 0, conventionalShare52: 0, weekendCommits52: 0, weekendShare52: 0, nightCommitsUtc52: 0,
        nightShareUtc52: 0, longestDailyStreak52: 0, maxCommit52: null, commitHoursUtc: emptyArray(24), commitDaysUtc: emptyArray(7),
        commitTypeCounts: emptyTypeCounts(), commitSizeBuckets: emptyArray(SIZE_LABELS.length), weeks: [], codeFrequency: [],
        seenCommits52: 0, commitsPer30DaysOfAge: 0, analyticsSource: 'github-graphql-default-branch-history+repository-metadata',
        analyticsError: error.message,
      };
    }
  }));
  results.push(...batch);
}

const valid = results.filter((repo) => !repo.analyticsError);
const addArrays = (key, length) => Array.from({ length }, (_, i) => sum(valid.map((repo) => repo[key]?.[i] || 0)));
const globalTypes = emptyTypeCounts();
for (const key of TYPE_KEYS) globalTypes[key] = sum(valid.map((repo) => repo.commitTypeCounts?.[key] || 0));
const languageMap = new Map();
for (const repo of valid) {
  for (const language of repo.languages || []) {
    const current = languageMap.get(language.name) || { name: language.name, color: language.color, bytes: 0 };
    current.bytes += language.bytes || 0;
    if (!current.color && language.color) current.color = language.color;
    languageMap.set(language.name, current);
  }
}
const languages = [...languageMap.values()].sort((a, b) => b.bytes - a.bytes);
const lifecycle = {
  active: results.filter((r) => r.activityState === 'active').length,
  cooling: results.filter((r) => r.activityState === 'cooling').length,
  dormant: results.filter((r) => r.activityState === 'dormant').length,
};

const totals = {
  repos: results.length,
  reposWithAnalytics: valid.length,
  commits52: sum(valid.map((repo) => repo.commits52)),
  lifetimeCommits: sum(valid.map((repo) => repo.lifetimeCommits)),
  additions52: sum(valid.map((repo) => repo.additions52)),
  deletions52: sum(valid.map((repo) => repo.deletions52)),
  churn52: sum(valid.map((repo) => repo.churn52)),
  fileTouches52: sum(valid.map((repo) => repo.fileTouches52)),
  branches: sum(valid.map((repo) => repo.branchCount)),
  tags: sum(valid.map((repo) => repo.tagCount)),
  releases: sum(valid.map((repo) => repo.releaseCount)),
  openIssues: sum(valid.map((repo) => repo.openIssues)),
  closedIssues: sum(valid.map((repo) => repo.closedIssues)),
  openPRs: sum(valid.map((repo) => repo.openPRs)),
  mergedPRs: sum(valid.map((repo) => repo.mergedPRs)),
  closedPRs: sum(valid.map((repo) => repo.closedPRs)),
  mergeCommits52: sum(valid.map((repo) => repo.mergeCommits52)),
  conventionalCommits52: sum(valid.map((repo) => repo.conventionalCommits52)),
  weekendCommits52: sum(valid.map((repo) => repo.weekendCommits52)),
  nightCommitsUtc52: sum(valid.map((repo) => repo.nightCommitsUtc52)),
  commitHoursUtc: addArrays('commitHoursUtc', 24),
  commitDaysUtc: addArrays('commitDaysUtc', 7),
  commitSizeBuckets: addArrays('commitSizeBuckets', SIZE_LABELS.length),
  commitSizeLabels: SIZE_LABELS,
  commitTypeCounts: globalTypes,
  lifecycle,
  languages,
};

totals.mergeShare52 = totals.commits52 ? Number(((totals.mergeCommits52 / totals.commits52) * 100).toFixed(1)) : 0;
totals.conventionalShare52 = totals.commits52 ? Number(((totals.conventionalCommits52 / totals.commits52) * 100).toFixed(1)) : 0;
totals.weekendShare52 = totals.commits52 ? Number(((totals.weekendCommits52 / totals.commits52) * 100).toFixed(1)) : 0;
totals.nightShareUtc52 = totals.commits52 ? Number(((totals.nightCommitsUtc52 / totals.commits52) * 100).toFixed(1)) : 0;
const decidedPRs = totals.mergedPRs + totals.closedPRs;
totals.prMergeRate = decidedPRs ? Number(((totals.mergedPRs / decidedPRs) * 100).toFixed(1)) : null;

const quality = {
  source: 'GitHub GraphQL default-branch linear commit history + repository metadata',
  scope: 'Non-fork, non-archived, public repositories owned by the account',
  window: 'Rolling 52 weeks from generation time for commit telemetry',
  generatedRepoCount: results.length,
  validRepoCount: valid.length,
  errorRepoCount: results.length - valid.length,
  changedFilesCoveragePercent: sum(valid.map((repo) => repo.commits52))
    ? Number(((sum(valid.map((repo) => repo.fileTouchCommitCount52)) / sum(valid.map((repo) => repo.commits52))) * 100).toFixed(1))
    : 100,
  branchTipSampleLimit: 100,
  notes: [
    'Commit telemetry counts only commits reachable from each repository default branch.',
    'Branch counts are exact; branch activity ages use up to the first 100 branch refs per repository.',
    'Pull request, issue, tag and release totals come from GitHub GraphQL repository metadata.',
    'Commit hour/day charts use committedDate in UTC.',
    'Changed-file averages exclude commits where GitHub returns changedFilesIfAvailable as null.',
  ],
};

await fs.mkdir('data', { recursive: true });
await fs.writeFile('data/stats.json', JSON.stringify({ generatedAt: new Date().toISOString(), user: USER, totals, quality, repos: results }, null, 2));
console.log(`Generated extended telemetry for ${valid.length}/${results.length} repositories.`);
