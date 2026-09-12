const GITHUB_USER = "MrHakan";
const API_ROOT = "https://api.github.com";
const CACHE_KEY = "repo-heat-map:v1";
const CACHE_TTL = 30 * 60 * 1000;
const MAX_HEAT_REPOS = 12;

const state = {
  repos: [],
  activity: [],
  rate: null,
  lastUpdated: null,
};

const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat("en-US");
const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const monthOnly = new Intl.DateTimeFormat("en", { month: "short" });

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "—";
  return shortDate.format(new Date(value));
}

function daysSince(value) {
  return (Date.now() - new Date(value).getTime()) / 86400000;
}

function updateRate(headers) {
  const remaining = headers.get("x-ratelimit-remaining");
  const limit = headers.get("x-ratelimit-limit");
  if (remaining !== null && limit !== null) {
    state.rate = { remaining: Number(remaining), limit: Number(limit) };
    $("#apiStatus").textContent = `api ${remaining}/${limit}`;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
    ...options,
  });
  updateRate(response.headers);

  if (response.status === 202) {
    const error = new Error("GitHub is still calculating repository statistics.");
    error.status = 202;
    throw error;
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
    } catch (_) {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function fetchAllRepos() {
  const repos = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await fetchJson(`${API_ROOT}/users/${GITHUB_USER}/repos?type=owner&sort=updated&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

function loadCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!cache?.savedAt || !Array.isArray(cache?.repos)) return null;
    if (Date.now() - cache.savedAt > CACHE_TTL) return null;
    return cache;
  } catch (_) {
    return null;
  }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      repos: state.repos,
      activity: state.activity,
    }));
  } catch (_) {}
}

async function fetchCommitActivity(repo) {
  const url = `${API_ROOT}/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/stats/commit_activity`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = await fetchJson(url);
      return { name: repo.name, url: repo.html_url, weeks: Array.isArray(data) ? data : [] };
    } catch (error) {
      if (error.status !== 202 || attempt === 2) {
        return { name: repo.name, url: repo.html_url, weeks: [], error: error.message };
      }
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
  }
  return { name: repo.name, url: repo.html_url, weeks: [] };
}

function activityCandidates(repos) {
  return repos
    .filter((repo) => !repo.fork && !repo.archived && !repo.disabled)
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, MAX_HEAT_REPOS);
}

function renderSummary() {
  const repos = state.repos;
  const totalStars = repos.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);
  const totalForks = repos.reduce((sum, repo) => sum + (repo.forks_count || 0), 0);
  const totalIssues = repos.reduce((sum, repo) => sum + (repo.open_issues_count || 0), 0);
  const active = repos.filter((repo) => repo.pushed_at && daysSince(repo.pushed_at) <= 90).length;

  $("#repoCount").textContent = number.format(repos.length);
  $("#starCount").textContent = number.format(totalStars);
  $("#forkCount").textContent = number.format(totalForks);
  $("#issueCount").textContent = number.format(totalIssues);
  $("#activeCount").textContent = number.format(active);
  $("#updatedAt").textContent = state.lastUpdated ? formatDate(state.lastUpdated) : "—";
}

function levelFor(value, max) {
  if (!value || !max) return 0;
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function normalizedWeeks(weeks) {
  const trimmed = weeks.slice(-52);
  if (trimmed.length >= 52) return trimmed;
  const missing = 52 - trimmed.length;
  return [...Array.from({ length: missing }, () => ({ total: 0, week: null })), ...trimmed];
}

function getWeekDates(activity) {
  const source = activity.find((item) => item.weeks?.length)?.weeks || [];
  const weeks = normalizedWeeks(source);
  return weeks.map((week, index) => {
    if (week.week) return new Date(week.week * 1000);
    const date = new Date();
    date.setDate(date.getDate() - ((51 - index) * 7));
    return date;
  });
}

function renderHeatmap() {
  const wrap = $("#heatmapWrap");
  if (!state.activity.length) {
    wrap.innerHTML = '<div class="loading-block">No commit activity available.</div>';
    return;
  }

  const dates = getWeekDates(state.activity);
  const monthLabels = dates.map((date, index) => {
    if (index === 0 || date.getMonth() !== dates[index - 1].getMonth()) return monthOnly.format(date);
    return "";
  });

  let html = '<div class="heatmap"><div class="heat-empty"></div>';
  monthLabels.forEach((label) => {
    html += `<div class="heat-month">${escapeHtml(label)}</div>`;
  });

  for (const repo of state.activity) {
    const weeks = normalizedWeeks(repo.weeks || []);
    const max = Math.max(0, ...weeks.map((week) => week.total || 0));
    html += `<div class="heat-label"><a href="${escapeHtml(repo.url)}" target="_blank" rel="noreferrer" title="${escapeHtml(repo.name)}">${escapeHtml(repo.name)}</a></div>`;
    weeks.forEach((week, index) => {
      const count = week.total || 0;
      const date = week.week ? new Date(week.week * 1000) : dates[index];
      const title = `${repo.name} · ${count} commit${count === 1 ? "" : "s"} · week of ${formatDate(date)}`;
      html += `<span class="heat-cell" data-level="${levelFor(count, max)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`;
    });
  }

  html += "</div>";
  wrap.innerHTML = html;
}

function aggregateWeeklyCommits() {
  const totals = Array(52).fill(0);
  for (const repo of state.activity) {
    const weeks = normalizedWeeks(repo.weeks || []);
    weeks.forEach((week, index) => { totals[index] += week.total || 0; });
  }
  return totals;
}

function renderTrend() {
  const root = $("#trendChart");
  const data = aggregateWeeklyCommits();
  const total = data.reduce((sum, value) => sum + value, 0);
  $("#commitTotal").textContent = number.format(total);

  if (!state.activity.some((item) => item.weeks?.length)) {
    root.innerHTML = '<div class="loading-block">Commit statistics unavailable.</div>';
    return;
  }

  const width = 720;
  const height = 210;
  const pad = { top: 10, right: 8, bottom: 24, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...data);
  const x = (index) => pad.left + (index / (data.length - 1)) * innerW;
  const y = (value) => pad.top + innerH - (value / max) * innerH;
  const points = data.map((value, index) => [x(index), y(value)]);
  const line = points.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
  const dates = getWeekDates(state.activity);

  const grid = [0, 0.5, 1].map((ratio) => {
    const gy = pad.top + innerH - (ratio * innerH);
    const label = Math.round(max * ratio);
    return `<line class="trend-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${gy}" y2="${gy}"/><text class="trend-label" x="0" y="${gy + 3}">${label}</text>`;
  }).join("");

  const labels = [0, 17, 34, 51].map((index) => {
    const anchor = index === 0 ? "start" : index === 51 ? "end" : "middle";
    return `<text class="trend-label" text-anchor="${anchor}" x="${x(index)}" y="${height - 4}">${monthOnly.format(dates[index])}</text>`;
  }).join("");

  root.innerHTML = `
    <svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly commit trend for tracked repositories">
      ${grid}
      <path class="trend-area" d="${area}"/>
      <path class="trend-line" d="${line}"/>
      ${labels}
    </svg>`;
}

function renderBarList(root, items, { maxItems = 7, link = false } = {}) {
  if (!items.length) {
    root.innerHTML = '<div class="loading-block">No data.</div>';
    return;
  }
  const visible = items.slice(0, maxItems);
  const max = Math.max(1, ...visible.map((item) => item.value));
  root.innerHTML = visible.map((item) => {
    const label = link
      ? `<a class="bar-label" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.label)}</a>`
      : `<span class="bar-label">${escapeHtml(item.label)}</span>`;
    return `<div class="bar-row">
      <div class="bar-meta">${label}<span class="bar-value">${number.format(item.value)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (item.value / max) * 100).toFixed(1)}%"></div></div>
    </div>`;
  }).join("");
}

function renderLanguages() {
  const counts = new Map();
  for (const repo of state.repos) {
    const language = repo.language || "Unspecified";
    counts.set(language, (counts.get(language) || 0) + 1);
  }
  const items = [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  renderBarList($("#languageChart"), items, { maxItems: 7 });
}

function renderStars() {
  const items = [...state.repos]
    .sort((a, b) => b.stargazers_count - a.stargazers_count || new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, 7)
    .map((repo) => ({ label: repo.name, value: repo.stargazers_count || 0, url: repo.html_url }));
  renderBarList($("#starChart"), items, { maxItems: 7, link: true });
}

function renderRecent() {
  const recent = [...state.repos]
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, 7);
  $("#recentList").innerHTML = recent.map((repo) => `
    <div class="recent-item">
      <div class="recent-name">
        <a href="${escapeHtml(repo.html_url)}" target="_blank" rel="noreferrer">${escapeHtml(repo.name)}</a>
        <small>${escapeHtml(repo.description || repo.language || "No description")}</small>
      </div>
      <time class="recent-date" datetime="${escapeHtml(repo.pushed_at)}">${formatDate(repo.pushed_at)}</time>
    </div>`).join("");
}

function sortedFilteredRepos() {
  const query = $("#repoSearch").value.trim().toLowerCase();
  const mode = $("#repoSort").value;
  const filtered = state.repos.filter((repo) => {
    if (!query) return true;
    return [repo.name, repo.description, repo.language, ...(repo.topics || [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  return filtered.sort((a, b) => {
    if (mode === "stars") return b.stargazers_count - a.stargazers_count || a.name.localeCompare(b.name);
    if (mode === "forks") return b.forks_count - a.forks_count || a.name.localeCompare(b.name);
    if (mode === "name") return a.name.localeCompare(b.name);
    return new Date(b.pushed_at) - new Date(a.pushed_at);
  });
}

function renderRepoTable() {
  const repos = sortedFilteredRepos();
  const body = $("#repoTableBody");
  if (!repos.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-cell">No repositories match this filter.</td></tr>';
    return;
  }

  body.innerHTML = repos.map((repo) => {
    const badges = [repo.archived ? "archived" : "", repo.fork ? "fork" : ""].filter(Boolean)
      .map((badge) => `<span class="repo-badge">${badge}</span>`).join("");
    const description = repo.description ? `<span class="repo-description">${escapeHtml(repo.description)}</span>` : "";
    return `<tr>
      <td><a class="repo-name" href="${escapeHtml(repo.html_url)}" target="_blank" rel="noreferrer">${escapeHtml(repo.name)}</a>${badges}${description}</td>
      <td class="repo-language">${escapeHtml(repo.language || "—")}</td>
      <td>${number.format(repo.stargazers_count || 0)}</td>
      <td>${number.format(repo.forks_count || 0)}</td>
      <td><time datetime="${escapeHtml(repo.pushed_at)}">${formatDate(repo.pushed_at)}</time></td>
    </tr>`;
  }).join("");
}

function renderRepoData() {
  renderSummary();
  renderLanguages();
  renderStars();
  renderRecent();
  renderRepoTable();
}

function renderActivity() {
  renderHeatmap();
  renderTrend();
}

function showError(message) {
  $("#errorText").textContent = message;
  $("#errorBox").hidden = false;
}

function clearError() {
  $("#errorBox").hidden = true;
  $("#errorText").textContent = "";
}

async function load({ force = false } = {}) {
  const refreshButton = $("#refreshButton");
  refreshButton.disabled = true;
  refreshButton.textContent = "loading…";
  clearError();

  if (force) localStorage.removeItem(CACHE_KEY);
  const cache = force ? null : loadCache();

  try {
    if (cache) {
      state.repos = cache.repos;
      state.activity = cache.activity || [];
      state.lastUpdated = new Date(cache.savedAt);
      $("#apiStatus").textContent = "cached";
      renderRepoData();
      renderActivity();
      return;
    }

    state.repos = await fetchAllRepos();
    state.lastUpdated = new Date();
    renderRepoData();

    const candidates = activityCandidates(state.repos);
    state.activity = await Promise.all(candidates.map(fetchCommitActivity));
    renderActivity();
    saveCache();

    const failed = state.activity.filter((item) => item.error).length;
    if (failed) showError(`${failed} repository commit-stat request${failed === 1 ? "" : "s"} did not return data. Repository statistics above are still valid.`);
  } catch (error) {
    showError(error.message || "Unknown GitHub API error.");
    $("#apiStatus").textContent = error.status === 403 ? "rate limited" : "api error";
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "refresh";
  }
}

$("#repoSearch").addEventListener("input", renderRepoTable);
$("#repoSort").addEventListener("change", renderRepoTable);
$("#refreshButton").addEventListener("click", () => load({ force: true }));

load();
