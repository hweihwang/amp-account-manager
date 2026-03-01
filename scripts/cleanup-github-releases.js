#!/usr/bin/env node
// Deletes all GitHub releases and tags except the current version.
// Keeps the repo clean — only one active release at a time.

const fs = require("fs");
const path = require("path");

const DEFAULT_REPO = "hweihwang/amp-account-manager";

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readFlagValue(flag) {
  const exactIndex = process.argv.indexOf(flag);
  if (exactIndex !== -1) return process.argv[exactIndex + 1] ?? null;
  const withEquals = process.argv.find(arg => arg.startsWith(`${flag}=`));
  if (!withEquals) return null;
  return withEquals.slice(flag.length + 1) || null;
}

function splitRepoSlug(slug) {
  const [owner, repo, ...rest] = slug.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`Invalid repo slug: ${slug}`);
  return { owner, repo };
}

function readPackageVersion() {
  const raw = fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed?.version) throw new Error("package.json version not found.");
  return parsed.version;
}

async function githubRequest({ method, url, token }) {
  const headers = {
    "User-Agent": "amp-account-manager-release-cleanup",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { method, headers });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${method} ${url} failed: ${res.status}: ${text}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function listPaginated({ urlBase, token }) {
  const items = [];
  for (let page = 1; page < 1000; page++) {
    const url = `${urlBase}${urlBase.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
    const chunk = await githubRequest({ method: "GET", url, token });
    if (!Array.isArray(chunk)) throw new Error(`Expected array for ${url}`);
    items.push(...chunk);
    if (chunk.length < 100) break;
  }
  return items;
}

(async () => {
  if (typeof fetch !== "function") throw new Error("Requires Node 18+.");

  const dryRun = hasFlag("--dry-run");
  const repoSlug = readFlagValue("--repo") || process.env.AMP_MANAGER_GITHUB_REPO || DEFAULT_REPO;
  const keepTagArg = readFlagValue("--keep-tag");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;

  if (!token && !dryRun) throw new Error("Missing GH_TOKEN or GITHUB_TOKEN.");

  const { owner, repo } = splitRepoSlug(repoSlug);
  const releases = await listPaginated({
    urlBase: `https://api.github.com/repos/${owner}/${repo}/releases`,
    token,
  });

  const keepRelease = releases.find(r => r?.draft === false) ?? releases[0] ?? null;
  const keepTag = keepTagArg || keepRelease?.tag_name || `v${readPackageVersion()}`;
  const keepTagRelease = keepTagArg
    ? releases.find(r => r?.tag_name === keepTagArg) ?? null
    : null;
  if (keepTagArg && !keepTagRelease) throw new Error(`No release for --keep-tag ${keepTagArg}.`);
  const keepReleaseId = keepTagRelease?.id ?? keepRelease?.id ?? null;
  if (!keepReleaseId && releases.length > 0) throw new Error("Could not determine release to keep.");

  console.log(`Repo: ${owner}/${repo} | Keep: ${keepTag} | Mode: ${dryRun ? "dry-run" : "delete"}`);

  const deletable = releases.filter(r => r?.id && r.id !== keepReleaseId);
  if (deletable.length === 0) {
    console.log("No old releases to delete.");
  } else {
    console.log(`Deleting ${deletable.length} release(s)...`);
    for (const release of deletable) {
      const label = `${release.tag_name ?? "??"} (#${release.id})`;
      if (dryRun) { console.log(`  - would delete release ${label}`); continue; }
      await githubRequest({
        method: "DELETE",
        url: `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`,
        token,
      });
      console.log(`  - deleted release ${label}`);
    }
  }

  const tags = await listPaginated({
    urlBase: `https://api.github.com/repos/${owner}/${repo}/tags`,
    token,
  });
  const deletableTags = tags.map(t => t?.name).filter(Boolean).filter(n => n !== keepTag);

  if (deletableTags.length === 0) {
    console.log("No old tags to delete.");
    return;
  }

  console.log(`Deleting ${deletableTags.length} tag(s)...`);
  for (const tagName of deletableTags) {
    if (dryRun) { console.log(`  - would delete tag ${tagName}`); continue; }
    try {
      await githubRequest({
        method: "DELETE",
        url: `https://api.github.com/repos/${owner}/${repo}/git/refs/tags/${encodeURIComponent(tagName)}`,
        token,
      });
      console.log(`  - deleted tag ${tagName}`);
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("404") || msg.includes("422")) {
        console.warn(`  - tag not found, skipping: ${tagName}`);
      } else {
        throw err;
      }
    }
  }
})().catch(err => { console.error(err); process.exit(1); });
