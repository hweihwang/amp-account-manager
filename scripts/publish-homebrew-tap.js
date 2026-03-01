#!/usr/bin/env node
// Publishes the generated cask to the homebrew tap repo.
// Run after `npm run homebrew:cask`.

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const caskPath = path.join(repoRoot, "homebrew", "Casks", "amp-account-manager.rb");
const tapRepo = process.env.AMP_MANAGER_TAP_REPO || "hweihwang/homebrew-amp-account-manager";
const tapBranch = process.env.AMP_MANAGER_TAP_BRANCH || "main";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;

function run(cmd) {
  cp.execSync(cmd, { stdio: "inherit" });
}

function readCaskVersion() {
  const raw = fs.readFileSync(caskPath, "utf8");
  const match = raw.match(/version\s+"([^"]+)"/);
  if (!match) throw new Error("Unable to read version from cask.");
  return match[1];
}

function main() {
  if (!fs.existsSync(caskPath)) {
    throw new Error("Missing cask. Run `npm run homebrew:cask` first.");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amp-account-manager-tap-"));
  const cloneUrl = `https://github.com/${tapRepo}.git`;

  run(`git clone --depth 1 --branch ${tapBranch} ${cloneUrl} "${tempDir}"`);

  const casksDir = path.join(tempDir, "Casks");
  fs.mkdirSync(casksDir, { recursive: true });
  fs.copyFileSync(caskPath, path.join(casksDir, "amp-account-manager.rb"));

  run(`git -C "${tempDir}" add Casks/amp-account-manager.rb`);

  const status = cp.execSync(`git -C "${tempDir}" status --porcelain`).toString().trim();
  if (!status) {
    console.log("Tap already up to date.");
    return;
  }

  const version = readCaskVersion();
  run(`git -C "${tempDir}" commit -m "chore(homebrew): update amp-account-manager cask v${version}"`);

  if (token) {
    run(
      `git -C "${tempDir}" remote set-url origin https://x-access-token:${token}@github.com/${tapRepo}.git`,
    );
  }

  run(`git -C "${tempDir}" push origin ${tapBranch}`);
  console.log(`Published cask v${version} to ${tapRepo}`);
}

if (require.main === module) {
  main();
}
