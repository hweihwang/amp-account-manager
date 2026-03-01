import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { app, BrowserWindow, ipcMain, shell } from "electron";

function fixPath() {
  if (process.platform === "win32") {
    // Windows GUI apps usually inherit full PATH; add common npm global paths just in case
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const extras = [
      appData ? path.join(appData, "npm") : "",
      localAppData ? path.join(localAppData, "fnm_multishells") : "",
      "C:\\Program Files\\nodejs",
    ].filter(Boolean);
    const current = process.env.PATH || "";
    const missing = extras.filter((p) => !current.toLowerCase().includes(p.toLowerCase()));
    if (missing.length) process.env.PATH = [...missing, current].join(";");
    return;
  }
  // macOS & Linux: packaged apps get a minimal PATH, resolve from user's login shell
  try {
    const userShell = process.env.SHELL || "/bin/sh";
    const result = execSync(`"${userShell}" -ilc 'printf "%s" "$PATH"'`, {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.trim()) process.env.PATH = result.trim();
  } catch {
    const home = process.env.HOME || "";
    const extras = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      home ? path.join(home, ".local", "bin") : "",
      home ? path.join(home, ".npm-global", "bin") : "",
      home ? path.join(home, ".nvm", "current", "bin") : "",
      home ? path.join(home, ".volta", "bin") : "",
      "/snap/bin",
    ].filter(Boolean);
    const current = process.env.PATH || "";
    const missing = extras.filter((p) => !current.includes(p));
    if (missing.length) process.env.PATH = [current, ...missing].join(":");
  }
}

fixPath();
import type {
  AmpAccount,
  AmpAccountUpsertPayload,
  DoctorCheck,
  ThreadRecord,
  UsageSnapshot,
} from "../shared/ipc";

const APP_NAME = "Amp Account Manager";
const DEFAULT_AMP_URL = "https://ampcode.com/";const DEFAULT_WORKSPACE_ROOT = process.env.AMP_MANAGER_WORKSPACE_ROOT?.trim() || "/Users/hweihwang/Projects";

type StoredAccount = {
  id: string;
  email: string;
  apiKeyCipherBase64: string;
  createdAt: number;
  updatedAt: number;
};

type StoreShape = {
  accounts: StoredAccount[];
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
};

const EMPTY_STORE: StoreShape = {
  accounts: [],
};

let mainWindow: BrowserWindow | null = null;

function now(): number {
  return Date.now();
}

function getUserDataPath(): string {
  return app.getPath("userData");
}

function storePath(): string {
  return path.join(getUserDataPath(), "accounts.json");
}

function ensureStoreDir(): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
}

function encryptSecret(raw: string): string {
  if (!raw.trim()) {
    throw new Error("API key cannot be empty");
  }
  return Buffer.from(raw, "utf8").toString("base64");
}

function decryptSecret(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

function loadStore(): StoreShape {
  ensureStoreDir();
  if (!fs.existsSync(storePath())) {
    return { ...EMPTY_STORE };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Record<string, unknown>;
    if (!Array.isArray(raw.accounts)) {
      return { ...EMPTY_STORE };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accounts: StoredAccount[] = (raw.accounts as any[])
      .filter((entry) => entry && typeof entry.id === "string" && typeof entry.apiKeyCipherBase64 === "string")
      .map((entry) => ({
        id: entry.id as string,
        // migrate: old records had `label`, new ones have `email`
        email: (entry.email ?? entry.label ?? "unknown") as string,
        apiKeyCipherBase64: entry.apiKeyCipherBase64 as string,
        createdAt: (entry.createdAt ?? 0) as number,
        updatedAt: (entry.updatedAt ?? 0) as number,
      }));
    return { accounts };
  } catch {
    return { ...EMPTY_STORE };
  }
}

function saveStore(store: StoreShape): void {
  ensureStoreDir();
  const tmpPath = `${storePath()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmpPath, storePath());
}

function mapAccount(entry: StoredAccount): AmpAccount {
  return {
    id: entry.id,
    email: entry.email,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    hasApiKey: Boolean(entry.apiKeyCipherBase64),
  };
}

function listAccounts(): AmpAccount[] {
  const store = loadStore();
  return store.accounts
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((entry) => mapAccount(entry));
}

function getStoredAccountOrThrow(accountId: string): StoredAccount {
  const store = loadStore();
  const account = store.accounts.find((entry) => entry.id === accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }
  return account;
}

function upsertAccount(payload: AmpAccountUpsertPayload): AmpAccount {
  const apiKey = payload.apiKey?.trim();

  const store = loadStore();
  const timestamp = now();

  if (payload.id) {
    const existing = store.accounts.find((entry) => entry.id === payload.id);
    if (!existing) {
      throw new Error(`Account not found: ${payload.id}`);
    }
    if (payload.email?.trim()) {
      existing.email = payload.email.trim();
    }
    if (apiKey) {
      existing.apiKeyCipherBase64 = encryptSecret(apiKey);
    }
    existing.updatedAt = timestamp;
    saveStore(store);
    return mapAccount(existing);
  }

  if (!apiKey) {
    throw new Error("API key is required");
  }

  const created: StoredAccount = {
    id: randomUUID(),
    email: payload.email?.trim() || "unknown",
    apiKeyCipherBase64: encryptSecret(apiKey),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  store.accounts.push(created);
  saveStore(store);
  return mapAccount(created);
}

function removeAccount(accountId: string): void {
  const store = loadStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((entry) => entry.id !== accountId);
  if (store.accounts.length === before) {
    throw new Error(`Account not found: ${accountId}`);
  }
  saveStore(store);
}

const BEGIN_MARKER = "# >>> amp-manager active account >>>";
const END_MARKER   = "# <<< amp-manager active account <<<";
const BLOCK_RE     = new RegExp(`${BEGIN_MARKER}[\\s\\S]*?${END_MARKER}`, "g");

type ShellTarget = {
  rcPath: string;
  block: string;
};

/**
 * Build the managed env block for posix-style shells (zsh, bash).
 * Uses `export KEY="value"` syntax.
 */
function posixBlock(apiKey: string, ampUrl: string): string {
  return [
    BEGIN_MARKER,
    `export AMP_API_KEY="${apiKey}"`,
    `export AMP_URL="${ampUrl}"`,
    END_MARKER,
  ].join("\n");
}

/**
 * Build the managed env block for fish shell.
 * Uses `set --export --global KEY value` syntax.
 */
function fishBlock(apiKey: string, ampUrl: string): string {
  return [
    BEGIN_MARKER,
    `set --export --global AMP_API_KEY "${apiKey}"`,
    `set --export --global AMP_URL "${ampUrl}"`,
    END_MARKER,
  ].join("\n");
}

/**
 * Upsert `block` into `rcPath`, replacing any previously managed block.
 * Creates the file (and its parent dirs) if it doesn't exist yet.
 */
function upsertBlock(rcPath: string, block: string): void {
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  let contents = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";
  if (BLOCK_RE.test(contents)) {
    // reset lastIndex after test()
    BLOCK_RE.lastIndex = 0;
    contents = contents.replace(BLOCK_RE, block);
  } else {
    contents = `${contents.trimEnd()}\n\n${block}\n`;
  }
  fs.writeFileSync(rcPath, contents, "utf8");
}

/**
 * Collect every shell rc file that exists on this machine so we update all
 * of them — the user might switch between fish, zsh, bash, etc.
 */
function resolveShellTargets(home: string, apiKey: string, ampUrl: string): ShellTarget[] {
  const posix = posixBlock(apiKey, ampUrl);
  const fish  = fishBlock(apiKey, ampUrl);

  const candidates: ShellTarget[] = [
    // fish
    { rcPath: path.join(home, ".config", "fish", "config.fish"), block: fish },
    // zsh
    { rcPath: path.join(home, ".zshrc"),     block: posix },
    { rcPath: path.join(home, ".zprofile"),  block: posix },
    // bash
    { rcPath: path.join(home, ".bashrc"),    block: posix },
    { rcPath: path.join(home, ".bash_profile"), block: posix },
  ];

  // Only update files that already exist — don't create rc files the user
  // never set up. Exception: fish config.fish is created if the fish dir
  // exists (fish won't error on a missing config.fish, but having one helps).
  return candidates.filter(({ rcPath }) => {
    if (fs.existsSync(rcPath)) return true;
    // Auto-create config.fish if the fish config dir already exists
    if (rcPath.endsWith("config.fish") && fs.existsSync(path.dirname(rcPath))) return true;
    return false;
  });
}

/**
 * Write AMP_API_KEY / AMP_URL into every shell rc file found on this machine
 * so that any new terminal session (fish, zsh, bash…) picks up the active
 * account automatically. Replaces any previously managed block in-place.
 */
function syncAccountToShell(account: StoredAccount): void {
  const home   = process.env.HOME ?? app.getPath("home");
  const apiKey = decryptSecret(account.apiKeyCipherBase64);

  const targets = resolveShellTargets(home, apiKey, DEFAULT_AMP_URL);
  for (const { rcPath, block } of targets) {
    upsertBlock(rcPath, block);
  }
}

/**
 * Read back whichever AMP_API_KEY is currently written inside our managed
 * block across all known shell rc files.  Returns the first key found, or
 * null if the block doesn't exist yet (fresh install / never synced).
 */
function readActiveKeyFromShell(): string | null {
  const home = process.env.HOME ?? app.getPath("home");

  const rcPaths = [
    path.join(home, ".config", "fish", "config.fish"),
    path.join(home, ".zshrc"),
    path.join(home, ".zprofile"),
    path.join(home, ".bashrc"),
    path.join(home, ".bash_profile"),
  ];

  for (const rcPath of rcPaths) {
    if (!fs.existsSync(rcPath)) continue;
    const contents = fs.readFileSync(rcPath, "utf8");

    // Only look inside our managed block
    const blockMatch = contents.match(
      new RegExp(`${BEGIN_MARKER}([\\s\\S]*?)${END_MARKER}`),
    );
    if (!blockMatch) continue;
    const block = blockMatch[1];

    // Match both syntaxes:
    //   export AMP_API_KEY="amp_..."          (posix)
    //   set --export --global AMP_API_KEY "amp_..."  (fish)
    const keyMatch = block.match(
      /(?:export\s+AMP_API_KEY="([^"]+)"|set\s+(?:--\S+\s+)*AMP_API_KEY\s+"([^"]+)")/,
    );
    if (keyMatch) return keyMatch[1] ?? keyMatch[2] ?? null;
  }

  return null;
}

/**
 * Find which stored account matches the key currently written in the shell.
 * Returns the account id, or null if nothing matches (e.g. first launch).
 */
function resolveActiveAccountId(): string | null {
  const activeKey = readActiveKeyFromShell();
  if (!activeKey) return null;

  const store = loadStore();
  const match = store.accounts.find((entry) => {
    try {
      return decryptSecret(entry.apiKeyCipherBase64) === activeKey;
    } catch {
      return false;
    }
  });

  return match?.id ?? null;
}

function buildAmpEnv(account: StoredAccount): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AMP_API_KEY: decryptSecret(account.apiKeyCipherBase64),
  };
}

function runAmp(account: StoredAccount, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("amp", ["--no-color", ...args], {
      cwd: DEFAULT_WORKSPACE_ROOT,
      env: buildAmpEnv(account),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const exitCode = typeof code === "number" ? code : -1;
      resolve({
        code: exitCode,
        stdout,
        stderr,
        combinedOutput: `${stdout}\n${stderr}`.trim(),
      });
    });
  });
}

function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/\x1B[PX^_][\s\S]*?\x1B\\/g, "")
    .replace(/\r/g, "");
}

function removeBackspaces(raw: string): string {
  let text = raw;
  while (/[^\n]\x08/.test(text)) {
    text = text.replace(/[^\n]\x08/g, "");
  }
  return text.replace(/\x08/g, "");
}

function normalizeTerminalOutput(raw: string): string {
  return removeBackspaces(stripAnsi(raw)).trim();
}

function ensureSuccess(result: CommandResult, action: string): string {
  const cleaned = normalizeTerminalOutput(result.combinedOutput);
  if (result.code !== 0) {
    const message = cleaned || `${action} failed with code ${result.code}`;
    throw new Error(message);
  }
  return cleaned;
}

function parseMoney(value: string): number | null {
  const parsed = Number.parseFloat(value.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUsageOutput(output: string): UsageSnapshot {
  const lines = output.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const signedInAs = lines.find((line) => line.startsWith("Signed in as "))?.replace(/^Signed in as\s+/, "") ?? null;
  const ampFreeLine = lines.find((line) => line.startsWith("Amp Free:")) ?? "";
  const individualLine = lines.find((line) => line.startsWith("Individual credits:")) ?? "";

  const ampFreeMatch = ampFreeLine.match(/\$([0-9.,]+)\/\$([0-9.,]+)\s+remaining/i);
  const replenishMatch = ampFreeLine.match(/replenishes \+\$([0-9.,]+)\/hour/i);
  const individualMatch = individualLine.match(/\$([0-9.,]+)/i);

  return {
    signedInAs,
    ampFreeRemaining: ampFreeMatch ? parseMoney(ampFreeMatch[1]) : null,
    ampFreeLimit: ampFreeMatch ? parseMoney(ampFreeMatch[2]) : null,
    replenishesPerHour: replenishMatch ? parseMoney(replenishMatch[1]) : null,
    individualCredits: individualMatch ? parseMoney(individualMatch[1]) : null,
    rawOutput: output,
    fetchedAt: now(),
  };
}

/**
 * Parse the thread list output from the CLI.
 * Returns minimal records — just id, title, lastUpdated, visibility, messages.
 * workspaceDir and precise updatedAtMs are filled in by enrichFromLocalFiles.
 */
function parseThreadsListOutput(output: string): ThreadRecord[] {
  const lines = output.split(/\n+/);
  const records: ThreadRecord[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const idMatch = line.match(/(T-[A-Za-z0-9-]+)$/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const left = line.slice(0, idMatch.index).trimEnd();
    const cells = left.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (cells.length < 4) continue;

    const messagesRaw = cells[cells.length - 1];
    const visibility = cells[cells.length - 2];
    const lastUpdated = cells[cells.length - 3];
    const title = cells.slice(0, cells.length - 3).join(" ");

    records.push({
      id,
      title,
      lastUpdated,
      visibility,
      messages: Number.isFinite(Number.parseInt(messagesRaw, 10)) ? Number.parseInt(messagesRaw, 10) : 0,
      updatedAtMs: 0,
    });
  }

  // Assign descending fake timestamps to preserve CLI order as a fallback
  // before local-file enrichment provides real dates.
  const base = Date.now();
  for (let i = 0; i < records.length; i++) {
    records[i].updatedAtMs = base - i * 1000;
  }

  return records;
}

/**
 * Enrich thread records with precise updatedAt timestamps and workspaceDir
 * by reading the local amp thread JSON files at ~/.local/share/amp/threads/.
 * These files are written by the amp CLI/IDE and contain the IDE workspace
 * trees (env.initial.trees[].displayName) — the exact project folder name.
 */
function enrichFromLocalFiles(records: ThreadRecord[]): ThreadRecord[] {
  const threadsDir = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "",
    ".local", "share", "amp", "threads",
  );

  return records.map((rec) => {
    try {
      const raw = fs.readFileSync(path.join(threadsDir, `${rec.id}.json`), "utf8");
      const data = JSON.parse(raw);

      const updatedAt: string = data.updatedAt ?? data.created ?? "";
      const updatedAtMs = updatedAt ? (Date.parse(updatedAt) || rec.updatedAtMs) : rec.updatedAtMs;

      const trees: Array<{ displayName?: string }> = data.env?.initial?.trees ?? [];
      const workspaceDir = trees[0]?.displayName ?? rec.workspaceDir;

      const title: string = data.title ?? rec.title;

      return { ...rec, title, updatedAtMs, workspaceDir };
    } catch {
      return rec;
    }
  });
}

// ── Browser-based OAuth login (replicates `amp login` CLI flow) ────────────

const LOGIN_PORT_MIN = 35789;
const LOGIN_PORT_MAX = 35799;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

let pendingLoginCancel: (() => void) | null = null;

function findFreePort(min: number, max: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = min;
    function tryNext() {
      if (port > max) {
        reject(new Error("No free port available for login callback"));
        return;
      }
      const server = http.createServer();
      server.listen(port, "127.0.0.1", () => {
        const p = port;
        server.close(() => resolve(p));
      });
      server.on("error", () => {
        port++;
        tryNext();
      });
    }
    tryNext();
  });
}

async function fetchSignedInAs(apiKey: string): Promise<string | null> {
  try {
    // Spin up a temporary fake account just to run `amp usage` and grab the email
    const tmpAccount: StoredAccount = {
      id: "__tmp__",
      email: "__tmp__",
      apiKeyCipherBase64: encryptSecret(apiKey),
      createdAt: 0,
      updatedAt: 0,
    };
    const result = await runAmp(tmpAccount, ["usage"], 15_000);
    if (result.code !== 0) return null;
    const cleaned = normalizeTerminalOutput(result.combinedOutput);
    const match = cleaned.match(/Signed in as\s+(.+)/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// ── Incognito browser launch ────────────────────────────────────────────────

// macOS bundle ID → incognito flag (all lowercase as macOS stores them)
const MAC_INCOGNITO: Record<string, string> = {
  "com.google.chrome":              "--incognito",
  "com.google.chrome.canary":       "--incognito",
  "com.google.chrome.beta":         "--incognito",
  "com.google.chrome.dev":          "--incognito",
  "com.microsoft.edgemac":          "--inprivate",
  "com.microsoft.edgemac.canary":   "--inprivate",
  "com.microsoft.edgemac.beta":     "--inprivate",
  "org.mozilla.firefox":            "--private-window",
  "org.mozilla.nightly":            "--private-window",
  "com.brave.browser":              "--incognito",
  "com.brave.browser.nightly":      "--incognito",
  "company.thebrowser.browser":     "--incognito",  // Arc
  "com.operasoftware.opera":        "--private",
  "com.vivaldi.vivaldi":            "--incognito",
};

// Windows ProgId prefix → { exe paths to try, flag }
const WIN_INCOGNITO: Record<string, { exes: string[]; flag: string }> = {
  ChromeHTML:  { exes: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"], flag: "--incognito" },
  MSEdgeHTM:   { exes: ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"], flag: "--inprivate" },
  BraveHTML:   { exes: ["C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"], flag: "--incognito" },
  FirefoxURL:  { exes: ["C:\\Program Files\\Mozilla Firefox\\firefox.exe", "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"], flag: "--private-window" },
};

// Linux .desktop → { exec, flag }
const LINUX_INCOGNITO: Record<string, { exec: string; flag: string }> = {
  "google-chrome.desktop":         { exec: "google-chrome",          flag: "--incognito" },
  "google-chrome-stable.desktop":  { exec: "google-chrome-stable",   flag: "--incognito" },
  "chromium.desktop":              { exec: "chromium",                flag: "--incognito" },
  "chromium-browser.desktop":      { exec: "chromium-browser",        flag: "--incognito" },
  "microsoft-edge.desktop":        { exec: "microsoft-edge",          flag: "--inprivate" },
  "brave-browser.desktop":         { exec: "brave-browser",           flag: "--incognito" },
  "firefox.desktop":               { exec: "firefox",                 flag: "--private-window" },
};

function spawnDetached(cmd: string, args: string[]): void {
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

function openIncognitoMac(url: string): boolean {
  try {
    const result = execSync(
      `defaults read ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null | grep -B1 "LSHandlerURLScheme = https;" | grep LSHandlerRoleAll | head -1`,
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    // Value is unquoted: `        LSHandlerRoleAll = "com.google.chrome.canary";`
    const bundleId = result.match(/LSHandlerRoleAll\s*=\s*"?([^";]+)"?/)?.[1]?.trim().toLowerCase();

    const flag = bundleId ? MAC_INCOGNITO[bundleId] : undefined;
    if (bundleId && flag) {
      // `open -nb <bundleId> --args <flag> <url>` — new instance, by bundle ID
      spawnDetached("open", ["-nb", bundleId, "--args", flag, url]);
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

function openIncognitoWin(url: string): boolean {
  try {
    const progId = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId`,
      { encoding: "utf8", timeout: 3000 },
    ).match(/ProgId\s+REG_SZ\s+(.+)/)?.[1]?.trim();

    const key = Object.keys(WIN_INCOGNITO).find((k) => progId?.startsWith(k));
    if (!key) return false;

    const { exes, flag } = WIN_INCOGNITO[key];
    const exe = exes.find((p) => fs.existsSync(p));
    if (!exe) return false;

    spawnDetached(exe, [flag, url]);
    return true;
  } catch { /* fall through */ }
  return false;
}

function openIncognitoLinux(url: string): boolean {
  try {
    const desktop = execSync("xdg-mime query default x-scheme-handler/http", { encoding: "utf8", timeout: 3000 }).trim();
    const entry = LINUX_INCOGNITO[desktop];
    if (!entry) return false;
    spawnDetached(entry.exec, [entry.flag, url]);
    return true;
  } catch { /* fall through */ }
  return false;
}

/** Open url in the default browser's private/incognito mode. Falls back to normal open. */
function openIncognito(url: string): void {
  let opened = false;
  if (process.platform === "darwin") opened = openIncognitoMac(url);
  else if (process.platform === "win32") opened = openIncognitoWin(url);
  else opened = openIncognitoLinux(url);

  if (!opened) {
    // Fallback: normal open (Safari, unknown browsers, etc.)
    void shell.openExternal(url);
  }
}

function loginWithBrowser(): Promise<AmpAccount> {
  // Cancel any in-flight login
  pendingLoginCancel?.();
  pendingLoginCancel = null;

  return new Promise(async (resolve, reject) => {
    const ampBase = "https://ampcode.com";
    const authToken = randomBytes(32).toString("hex");

    let callbackPort: number;
    try {
      callbackPort = await findFreePort(LOGIN_PORT_MIN, LOGIN_PORT_MAX);
    } catch (err) {
      return reject(err);
    }

    let settled = false;

    function cancel(reason: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      pendingLoginCancel = null;
      reject(new Error(reason));
    }

    pendingLoginCancel = () => cancel("Login cancelled.");

    const timeout = setTimeout(() => {
      cancel("Login timed out. Please try again.");
    }, LOGIN_TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, `http://127.0.0.1:${callbackPort}`);
      if (url.pathname !== "/auth/callback") return;

      const accessToken = url.searchParams.get("accessToken");
      const returnedAuthToken = url.searchParams.get("authToken");

      // Serve a friendly close-me page to the browser
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Amp Login</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8;}
.box{text-align:center;padding:40px;border-radius:12px;background:#fff;box-shadow:0 2px 24px rgba(0,0,0,.08);}
h2{margin:0 0 8px;color:#1a1a2e;}p{color:#666;margin:0;}</style></head>
<body><div class="box"><h2>${accessToken ? "✅ Logged in!" : "⚠️ Login failed"}</h2>
<p>${accessToken ? "You can close this tab and return to Amp Account Manager." : "No token received. Please try again."}</p></div></body></html>`);

      if (settled || !accessToken) return;
      if (returnedAuthToken && returnedAuthToken !== authToken) return;

      settled = true;
      clearTimeout(timeout);
      server.close();
      pendingLoginCancel = null;

      // Fetch email to use as label, then save
      void fetchSignedInAs(accessToken).then((email) => {
        try {
          const account = upsertAccount({
            email: email ?? "unknown",
            apiKey: accessToken,
          });
          resolve(account);
        } catch (err) {
          reject(err);
        }
      });
    });

    server.listen(callbackPort, "127.0.0.1", () => {
      const loginUrl = `${ampBase}/auth/cli-login?authToken=${authToken}&callbackPort=${callbackPort}`;
      openIncognito(loginUrl);
    });

    server.on("error", (err) => {
      cancel((err as Error).message ?? "Login server error.");
    });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 760,
    title: APP_NAME,
    backgroundColor: "#f5f6f8",
    icon: path.join(__dirname, "../build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_START_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_START_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle("accounts:list", async (): Promise<AmpAccount[]> => {
    return listAccounts();
  });

  ipcMain.handle("accounts:upsert", async (_event, payload: AmpAccountUpsertPayload): Promise<AmpAccount> => {
    return upsertAccount(payload);
  });

  ipcMain.handle("accounts:remove", async (_event, accountId: string): Promise<void> => {
    removeAccount(accountId);
  });

  ipcMain.handle("accounts:activate", async (_event, accountId: string): Promise<void> => {
    const account = getStoredAccountOrThrow(accountId);
    syncAccountToShell(account);
  });

  ipcMain.handle("accounts:getActiveId", async (): Promise<string | null> => {
    return resolveActiveAccountId();
  });

  ipcMain.handle("accounts:loginWithBrowser", async (): Promise<AmpAccount> => {
    return loginWithBrowser();
  });

  ipcMain.handle("accounts:cancelBrowserLogin", async (): Promise<void> => {
    pendingLoginCancel?.();
    pendingLoginCancel = null;
  });

  ipcMain.handle("usage:get", async (_event, accountId: string): Promise<UsageSnapshot> => {
    const account = getStoredAccountOrThrow(accountId);
    const result = await runAmp(account, ["usage"]);
    const cleaned = ensureSuccess(result, "Read usage");
    return parseUsageOutput(cleaned);
  });

  ipcMain.handle("threads:list", async (_event, accountId: string): Promise<ThreadRecord[]> => {
    const account = getStoredAccountOrThrow(accountId);
    const result = await runAmp(account, ["threads", "list", "--include-archived"]);
    const cleaned = ensureSuccess(result, "List threads");
    // CLI gives the account-scoped list; local files give workspaceDir + precise timestamps
    const records = parseThreadsListOutput(cleaned);
    return enrichFromLocalFiles(records);
  });

  ipcMain.handle("threads:markdown", async (_event, payload: { accountId: string; threadId: string }): Promise<string> => {
    const account = getStoredAccountOrThrow(payload.accountId);
    const result = await runAmp(account, ["threads", "markdown", payload.threadId], 180_000);
    return ensureSuccess(result, "Fetch thread markdown");
  });

  ipcMain.handle("doctor:run", async (): Promise<DoctorCheck[]> => {
    const checks: DoctorCheck[] = [];

    // 1. Check if amp CLI is in PATH
    const ampPath = (() => {
      try {
        const cmd = process.platform === "win32" ? "where amp" : "which amp";
        return execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim().split(/\r?\n/)[0];
      } catch {
        return null;
      }
    })();

    if (ampPath) {
      checks.push({ id: "amp-found", label: "Amp CLI found", status: "pass", message: ampPath });
    } else {
      checks.push({
        id: "amp-found",
        label: "Amp CLI found",
        status: "fail",
        message: "Could not find 'amp' in PATH.",
        fix: "Install the Amp CLI: npm install -g @anthropic-ai/amp",
      });
    }

    // 2. Check amp version
    if (ampPath) {
      try {
        const version = execSync("amp --version", { encoding: "utf8", timeout: 10000 }).trim();
        checks.push({ id: "amp-version", label: "Amp CLI version", status: "pass", message: version });
      } catch {
        checks.push({
          id: "amp-version",
          label: "Amp CLI version",
          status: "warn",
          message: "Found amp but could not determine version.",
          fix: "Try running 'amp --version' manually to check for issues.",
        });
      }
    }

    // 3. Check workspace directory
    const wsRoot = DEFAULT_WORKSPACE_ROOT;
    try {
      const stat = fs.statSync(wsRoot);
      if (stat.isDirectory()) {
        checks.push({ id: "workspace", label: "Workspace directory", status: "pass", message: wsRoot });
      } else {
        checks.push({
          id: "workspace",
          label: "Workspace directory",
          status: "fail",
          message: `${wsRoot} exists but is not a directory.`,
          fix: "Set AMP_MANAGER_WORKSPACE_ROOT to a valid directory path.",
        });
      }
    } catch {
      checks.push({
        id: "workspace",
        label: "Workspace directory",
        status: "fail",
        message: `${wsRoot} does not exist.`,
        fix: `Create the directory: mkdir -p "${wsRoot}"`,
      });
    }

    // 4. Check Node.js availability
    try {
      const nodeVersion = execSync("node --version", { encoding: "utf8", timeout: 5000 }).trim();
      checks.push({ id: "node", label: "Node.js", status: "pass", message: nodeVersion });
    } catch {
      checks.push({
        id: "node",
        label: "Node.js",
        status: "warn",
        message: "Node.js not found in PATH.",
        fix: "Install Node.js from https://nodejs.org or via your package manager.",
      });
    }

    // 5. Check resolved PATH (diagnostic)
    const resolvedPath = process.env.PATH || "";
    const pathDirs = resolvedPath.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
    checks.push({
      id: "path",
      label: "PATH directories",
      status: pathDirs.length > 2 ? "pass" : "warn",
      message: `${pathDirs.length} directories in PATH.`,
      fix: pathDirs.length <= 2 ? "Your PATH looks too short. The app may not find CLI tools. Try restarting the app or check your shell configuration." : undefined,
    });

    // 6. Check shell config (macOS/Linux only)
    if (process.platform !== "win32") {
      const home = process.env.HOME || "";
      const shellConfigFiles = [".zshrc", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"];
      const found = shellConfigFiles.filter((f) => {
        try { return fs.existsSync(path.join(home, f)); } catch { return false; }
      });
      if (found.length > 0) {
        checks.push({ id: "shell-config", label: "Shell config", status: "pass", message: found.map((f) => `~/${f}`).join(", ") });
      } else {
        checks.push({
          id: "shell-config",
          label: "Shell config",
          status: "warn",
          message: "No shell config files found.",
          fix: "Create ~/.zshrc or ~/.bashrc to ensure your PATH is configured properly.",
        });
      }
    }

    // 7. Platform info
    checks.push({
      id: "platform",
      label: "Platform",
      status: "pass",
      message: `${process.platform} ${process.arch} — Electron ${process.versions.electron}`,
    });

    return checks;
  });

  ipcMain.handle("app:openExternal", async (_event, url: string): Promise<void> => {
    await shell.openExternal(url);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
