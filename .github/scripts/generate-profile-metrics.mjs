import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const username = process.env.PROFILE_USERNAME || "Ryane23";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const generatedAt = new Date();
const today = generatedAt.toISOString().slice(0, 10);

const contributionQuery = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      login
      createdAt
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays { date contributionCount }
          }
        }
      }
    }
  }
`;

async function githubRequest(path, options = {}) {
  if (!token) {
    const args = ["api"];
    if (options.graphql) {
      args.push("graphql", "-f", `query=${options.query}`);
      for (const [key, value] of Object.entries(options.variables)) {
        args.push("-F", `${key}=${value}`);
      }
    } else {
      args.push(path);
    }
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
  }

  const url = options.graphql ? "https://api.github.com/graphql" : `https://api.github.com/${path}`;
  const response = await fetch(url, {
    method: options.graphql ? "POST" : "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": `${username}-profile-metrics`,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: options.graphql ? JSON.stringify({ query: options.query, variables: options.variables }) : undefined
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function getContributions(from, to) {
  const result = await githubRequest("graphql", {
    graphql: true,
    query: contributionQuery,
    variables: { login: username, from, to }
  });
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  return result.data.user;
}

async function getAllRepos() {
  const repos = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(`users/${username}/repos?per_page=100&type=owner&sort=pushed&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((repo) => !repo.fork);
}

async function getReachableProjects(repos) {
  const checks = await Promise.all(repos.map(async (repo) => {
    try {
      const response = await fetch(repo.homepage, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
        headers: { "User-Agent": username + "-profile-metrics" }
      });
      return response.status >= 200 && response.status < 400 ? repo : null;
    } catch {
      return null;
    }
  }));
  return checks.filter(Boolean);
}

async function getLanguageTotals(repos) {
  const totals = {};
  for (const repo of repos) {
    const languages = await githubRequest(`repos/${username}/${encodeURIComponent(repo.name)}/languages`);
    for (const [language, bytes] of Object.entries(languages)) {
      totals[language] = (totals[language] || 0) + bytes;
    }
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}

function calculateStreaks(days) {
  let longest = 0;
  let running = 0;
  for (const day of days) {
    if (day.contributionCount > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }
  let index = days.findIndex((day) => day.date === today);
  if (index === -1) index = days.length - 1;
  if (days[index]?.contributionCount === 0) index -= 1;
  let current = 0;
  while (index >= 0 && days[index].contributionCount > 0) {
    current += 1;
    index -= 1;
  }
  return { current, longest };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function compact(value) {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function heatColor(count, maximum) {
  if (!count) return "#101B2A";
  const ratio = count / Math.max(maximum, 1);
  if (ratio > 0.7) return "#A855F7";
  if (ratio > 0.4) return "#22D3EE";
  if (ratio > 0.15) return "#14B8A6";
  return "#166534";
}

const initial = await getContributions(`${generatedAt.getUTCFullYear()}-01-01T00:00:00Z`, generatedAt.toISOString());
const startYear = new Date(initial.createdAt).getUTCFullYear();
const currentYear = generatedAt.getUTCFullYear();
const yearly = [];
const dayMap = new Map();

for (let year = startYear; year <= currentYear; year += 1) {
  const from = `${year}-01-01T00:00:00Z`;
  const to = year === currentYear ? generatedAt.toISOString() : `${year}-12-31T23:59:59Z`;
  const data = year === currentYear ? initial : await getContributions(from, to);
  const calendar = data.contributionsCollection.contributionCalendar;
  yearly.push({ year, contributions: calendar.totalContributions });
  for (const week of calendar.weeks) {
    for (const day of week.contributionDays) {
      if (day.date >= initial.createdAt.slice(0, 10) && day.date <= today) dayMap.set(day.date, day);
    }
  }
}

const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
const repos = await getAllRepos();
const languageTotals = await getLanguageTotals(repos);
const languageBytes = languageTotals.reduce((sum, [, bytes]) => sum + bytes, 0);
const topLanguages = languageTotals.slice(0, 5).map(([name, bytes]) => ({
  name,
  bytes,
  percent: languageBytes ? (bytes / languageBytes) * 100 : 0
}));
const publishedProjects = repos.filter((repo) => /^https?:\/\//.test(repo.homepage || ""));
const liveProjects = await getReachableProjects(publishedProjects);
const recentProjects = repos
  .filter((repo) => repo.name.toLowerCase() !== username.toLowerCase() && repo.language)
  .slice(0, 6)
  .map((repo) => ({
    name: repo.name,
    language: repo.language,
    url: repo.html_url,
    liveUrl: /^https?:\/\//.test(repo.homepage || "") ? repo.homepage : null,
    pushedAt: repo.pushed_at
  }));

const streaks = calculateStreaks(days);
const activeDays = days.filter((day) => day.contributionCount > 0).length;
const bestDay = days.reduce((best, day) => day.contributionCount > best.contributionCount ? day : best, { date: today, contributionCount: 0 });
const totalContributions = yearly.reduce((sum, year) => sum + year.contributions, 0);
const last30 = days.slice(-30).reduce((sum, day) => sum + day.contributionCount, 0);

const metrics = {
  source: "GitHub GraphQL contribution calendar and REST repository/language APIs",
  generatedAt: generatedAt.toISOString(),
  username,
  summary: {
    totalContributions,
    activeDays,
    currentStreak: streaks.current,
    longestStreak: streaks.longest,
    bestDay,
    last30Contributions: last30,
    publicRepositories: repos.length,
    liveProjects: liveProjects.length,
    publishedProjectLinks: publishedProjects.length
  },
  definitions: {
    liveProjects: "Public repository homepages returning HTTP 200–399 at refresh time.",
    publishedProjectLinks: "Public repositories with a non-empty HTTP(S) homepage/demo URL.",
    currentStreak: "Consecutive contribution days ending today, or yesterday when today has no contribution yet."
  },
  yearly,
  topLanguages,
  recentProjects,
  liveProjects: liveProjects.map((repo) => ({ name: repo.name, url: repo.html_url, liveUrl: repo.homepage })),
  publishedProjects: publishedProjects.map((repo) => ({ name: repo.name, url: repo.html_url, liveUrl: repo.homepage }))
};

const maxYear = Math.max(...yearly.map((item) => item.contributions), 1);
const yearRows = yearly.slice(-5).map((item, index) => {
  const width = Math.max(8, Math.round((item.contributions / maxYear) * 390));
  const y = 302 + index * 36;
  return `
    <text x="54" y="${y + 13}" class="mono label">${item.year}</text>
    <rect x="112" y="${y}" width="390" height="16" rx="8" fill="#101B2A"/>
    <rect class="grow" style="--target:${width}px; animation-delay:${index * 0.12}s" x="112" y="${y}" width="${width}" height="16" rx="8" fill="url(#bar)"/>
    <text x="516" y="${y + 13}" class="mono value-small">${item.contributions}</text>`;
}).join("");

const languagePalette = ["#A855F7", "#22D3EE", "#4ADE80", "#FACC15", "#FB7185"];
const languageRows = topLanguages.map((item, index) => {
  const width = Math.max(8, Math.round((item.percent / Math.max(topLanguages[0]?.percent || 1, 1)) * 320));
  const y = 302 + index * 36;
  return `
    <text x="662" y="${y + 13}" class="mono label">${xml(item.name.slice(0, 12))}</text>
    <rect x="790" y="${y}" width="320" height="16" rx="8" fill="#101B2A"/>
    <rect class="grow" style="--target:${width}px; animation-delay:${index * 0.12 + 0.2}s" x="790" y="${y}" width="${width}" height="16" rx="8" fill="${languagePalette[index]}"/>
    <text x="1124" y="${y + 13}" class="mono value-small" text-anchor="end">${item.percent.toFixed(1)}%</text>`;
}).join("");

const heatDays = days.slice(-364);
const heatMaximum = Math.max(...heatDays.map((day) => day.contributionCount), 1);
const heatmap = heatDays.map((day, index) => {
  const column = Math.floor(index / 7);
  const row = index % 7;
  const x = 54 + column * 21;
  const y = 542 + row * 17;
  const delay = (column * 0.012).toFixed(3);
  return `<rect class="cell" style="animation-delay:${delay}s" x="${x}" y="${y}" width="14" height="14" rx="3" fill="${heatColor(day.contributionCount, heatMaximum)}"><title>${day.date}: ${day.contributionCount} contributions</title></rect>`;
}).join("");

const statCards = [
  ["CURRENT STREAK", `${streaks.current}d`, "#4ADE80"],
  ["LONGEST STREAK", `${streaks.longest}d`, "#22D3EE"],
  ["TOTAL SIGNAL", compact(totalContributions), "#A855F7"],
  ["BEST DAY", bestDay.contributionCount, "#FACC15"],
  ["PUBLIC REPOS", repos.length, "#38BDF8"],
  ["LIVE PROJECTS", liveProjects.length, "#FB7185"]
].map(([label, value, color], index) => {
  const x = 42 + index * 190;
  return `<g transform="translate(${x} 124)">
    <rect width="174" height="102" rx="12" fill="#081421" stroke="#16344A"/>
    <circle class="pulse" cx="20" cy="21" r="4" fill="${color}"/>
    <text x="32" y="25" class="mono stat-label">${label}</text>
    <text x="18" y="70" class="mono stat-value" fill="${color}">${value}</text>
  </g>`;
}).join("");

const svg = `<svg width="1200" height="700" viewBox="0 0 1200 700" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Live GitHub telemetry for ${xml(username)}</title>
  <desc id="desc">Real GitHub contribution streaks, yearly activity, repositories, deployed project links, languages, and a 52-week contribution matrix.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="700" gradientUnits="userSpaceOnUse"><stop stop-color="#040A13"/><stop offset=".55" stop-color="#071523"/><stop offset="1" stop-color="#10091C"/></linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1200" y2="0"><stop stop-color="#22D3EE"/><stop offset=".5" stop-color="#A855F7"/><stop offset="1" stop-color="#4ADE80"/></linearGradient>
    <linearGradient id="bar" x1="112" y1="0" x2="502" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="#0EA5E9"/><stop offset=".55" stop-color="#A855F7"/><stop offset="1" stop-color="#4ADE80"/></linearGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" stroke="#38BDF8" stroke-opacity=".045"/></pattern>
    <filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <style>
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace}.label{font-size:13px;fill:#94A3B8}.value-small{font-size:13px;fill:#E2E8F0}.stat-label{font-size:10px;letter-spacing:1.1px;fill:#64748B}.stat-value{font-size:29px;font-weight:700}.grow{animation:grow 1.2s cubic-bezier(.2,.8,.2,1) both}.cell{animation:cell .8s ease-out both}.pulse{animation:pulse 2s ease-in-out infinite;filter:url(#glow)}.scan{animation:scan 5s linear infinite}.cursor{animation:blink 1s steps(1) infinite}@keyframes grow{from{width:0}to{width:var(--target)}}@keyframes cell{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}@keyframes scan{from{transform:translateX(-300px)}to{transform:translateX(1450px)}}@keyframes blink{0%,48%{opacity:1}49%,100%{opacity:0}}@media(prefers-reduced-motion:reduce){.grow,.cell,.pulse,.scan,.cursor{animation:none}}
  </style>
  <rect x="1" y="1" width="1198" height="698" rx="20" fill="url(#bg)" stroke="url(#edge)" stroke-width="2"/>
  <rect x="16" y="16" width="1168" height="668" rx="14" fill="url(#grid)"/>
  <rect class="scan" x="-300" y="2" width="300" height="696" fill="url(#edge)" opacity=".035"/>
  <text x="46" y="52" class="mono" font-size="12" letter-spacing="2.2" fill="#64748B">GITHUB://LIVE_TELEMETRY/${xml(username.toUpperCase())}</text>
  <text x="46" y="91" class="mono" font-size="27" font-weight="700" fill="#F8FAFC">REAL ACTIVITY. TRACEABLE PROGRESS.</text>
  <rect class="cursor" x="626" y="69" width="10" height="25" rx="1" fill="#22D3EE"/>
  <g transform="translate(916 42)"><rect width="238" height="48" rx="9" fill="#07111D" stroke="#164E63"/><circle class="pulse" cx="20" cy="24" r="5" fill="#4ADE80"/><text x="34" y="28" class="mono" font-size="11" letter-spacing="1" fill="#86EFAC">SYNCED ${xml(today)}</text></g>
  ${statCards}
  <text x="48" y="270" class="mono" font-size="12" letter-spacing="2" fill="#64748B">CONTRIBUTIONS BY YEAR</text>
  <text x="656" y="270" class="mono" font-size="12" letter-spacing="2" fill="#64748B">LANGUAGE BYTES ACROSS PUBLIC REPOS</text>
  ${yearRows}
  ${languageRows}
  <path d="M600 266V482" stroke="#16344A"/>
  <text x="48" y="515" class="mono" font-size="12" letter-spacing="2" fill="#64748B">52 WEEK CONTRIBUTION MATRIX</text>
  <text x="1152" y="515" class="mono" font-size="11" fill="#64748B" text-anchor="end">BEST: ${bestDay.contributionCount} ON ${xml(formatDate(bestDay.date).toUpperCase())} · LAST 30D: ${last30}</text>
  ${heatmap}
  <g transform="translate(48 674)"><circle cx="4" cy="-4" r="4" fill="#4ADE80"/><text x="16" y="0" class="mono" font-size="10" letter-spacing="1" fill="#64748B">SOURCE: GITHUB GRAPHQL + REST · ACTIVE DAYS: ${activeDays} · LIVE PROJECTS = HTTP-VERIFIED DEPLOYMENTS</text></g>
</svg>`;

await mkdir("public", { recursive: true });
await writeFile("public/github-live-metrics.svg", svg.replace(/^[ \t]+$/gm, ""));
await writeFile("public/github-live-data.json", `${JSON.stringify(metrics, null, 2)}\n`);
console.log(`Generated metrics for ${username}: ${totalContributions} contributions, ${repos.length} repos, ${liveProjects.length} live links.`);
