#!/usr/bin/env node
// Clears the body/notes of the current version's GitHub release.
// Useful for keeping release pages clean — no auto-generated diff noise.

const fs = require("fs");
const path = require("path");

const DEFAULT_REPO = "hweihwang/amp-account-manager";

function readPackageVersion() {
  const raw = fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed?.version) throw new Error("package.json version not found.");
  return parsed.version;
}

function splitRepoSlug(slug) {
  const [owner, repo, ...rest] = slug.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`Invalid repo slug: ${slug}`);
  return { owner, repo };
}

async function githubRequest({ method, url, token, body }) {
  const headers = {
    "User-Agent": "amp-account-manager-release-notes-cleaner",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${method} ${url} failed: ${res.status}: ${text}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  if (typeof fetch !== "function") throw new Error("Requires Node 18+.");

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
  if (!token) throw new Error("Missing GH_TOKEN or GITHUB_TOKEN.");

  const repoSlug = process.env.AMP_MANAGER_GITHUB_REPO || DEFAULT_REPO;
  const { owner, repo } = splitRepoSlug(repoSlug);
  const tag = `v${readPackageVersion()}`;

  const release = await githubRequest({
    method: "GET",
    url: `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    token,
  });

  if (!release?.id) throw new Error(`Release not found for tag ${tag}.`);

  await githubRequest({
    method: "PATCH",
    url: `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`,
    token,
    body: { body: "" },
  });

  console.log(`Cleared release notes for ${owner}/${repo} ${tag}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
