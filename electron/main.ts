import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import type {
  AmpAccount,
  AmpAccountUpsertPayload,
  ThreadRecord,
  UsageSnapshot,
} from "../shared/ipc";

const APP_NAME = "Amp Account Manager";
const DEFAULT_AMP_URL = "https://ampcode.com/";
const DEFAULT_WORKSPACE_ROOT = process.env.AMP_MANAGER_WORKSPACE_ROOT?.trim() || "/Users/hweihwang/Projects";

type StoredAccount = {
  id: string;
  label: string;
  ampUrl: string | null;
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

function normalizeAmpUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
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
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(raw).toString("base64");
  }
  return Buffer.from(raw, "utf8").toString("base64");
}

function decryptSecret(base64: string): string {
  const raw = Buffer.from(base64, "base64");
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(raw);
  }
  return raw.toString("utf8");
}

function loadStore(): StoreShape {
  ensureStoreDir();
  if (!fs.existsSync(storePath())) {
    return { ...EMPTY_STORE };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as StoreShape;
    if (!Array.isArray(parsed.accounts)) {
      return { ...EMPTY_STORE };
    }
    return {
      accounts: parsed.accounts.filter((entry) => entry && typeof entry.id === "string" && typeof entry.label === "string"),
    };
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
    label: entry.label,
    ampUrl: entry.ampUrl,
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
  const label = payload.label?.trim();
  const apiKey = payload.apiKey?.trim();
  if (!label) {
    throw new Error("Label is required");
  }

  const store = loadStore();
  const timestamp = now();
  const normalizedUrl = normalizeAmpUrl(payload.ampUrl ?? null);

  if (payload.id) {
    const existing = store.accounts.find((entry) => entry.id === payload.id);
    if (!existing) {
      throw new Error(`Account not found: ${payload.id}`);
    }
    existing.label = label;
    existing.ampUrl = normalizedUrl;
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
    label,
    ampUrl: normalizedUrl,
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
  const ampUrl = account.ampUrl ?? DEFAULT_AMP_URL;

  const targets = resolveShellTargets(home, apiKey, ampUrl);
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AMP_API_KEY: decryptSecret(account.apiKeyCipherBase64),
  };
  if (account.ampUrl) {
    env.AMP_URL = account.ampUrl;
  } else {
    delete env.AMP_URL;
  }
  return env;
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

function parseThreadsListOutput(output: string): ThreadRecord[] {
  const lines = output.split(/\n+/);
  const records: ThreadRecord[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const idMatch = line.match(/(T-[A-Za-z0-9-]+)$/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const left = line.slice(0, idMatch.index).trimEnd();
    const cells = left.split(/\s{2,}/).map((entry) => entry.trim()).filter(Boolean);
    if (cells.length < 4) continue;

    const messagesRaw = cells[cells.length - 1];
    const visibility = cells[cells.length - 2];
    const lastUpdated = cells[cells.length - 3];
    const title = cells.slice(0, cells.length - 3).join(" ");
    const messages = Number.parseInt(messagesRaw, 10);

    records.push({
      id,
      title,
      lastUpdated,
      visibility,
      messages: Number.isFinite(messages) ? messages : 0,
      updatedAtMs: 0,
    });
  }

  // CLI output is already most-recent first; assign descending fake timestamps
  // so sort order is preserved before markdown enrichment provides real dates.
  const base = Date.now();
  for (let i = 0; i < records.length; i++) {
    records[i].updatedAtMs = base - i * 1000;
  }

  return records;
}

/**
 * Extract the full thread title and workspace directory from the markdown
 * frontmatter + first few lines of content. Only the opening bytes are needed
 * so we bail out early via a lightweight regex on the raw output.
 */
function extractMarkdownMeta(raw: string): { fullTitle?: string; workspaceDir?: string; updatedAtMs?: number } {
  // Pull title from YAML frontmatter: `title: ...`
  const titleMatch = raw.match(/^---[\s\S]*?^title:\s*(.+)/m);
  const fullTitle = titleMatch ? titleMatch[1].trim() : undefined;

  // Parse the real updatedAt ISO timestamp from frontmatter if present
  const updatedAtMatch = raw.match(/^updatedAt:\s*(.+)/m);
  const updatedAtMs = updatedAtMatch
    ? (Date.parse(updatedAtMatch[1].trim()) || undefined)
    : undefined;

  // Extract workspace dir from the first absolute path that looks like a project root.
  const pathMatch = raw.match(/(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)\/(?:Projects|dev|src|code|work|repos?|workspace)[^/\s]*\/([A-Za-z0-9_.\-]+)/i);
  const workspaceDir = pathMatch ? pathMatch[1] : undefined;

  return { fullTitle, workspaceDir, updatedAtMs };
}

/**
 * For threads whose title was truncated by the CLI (ends with "..."), fetch
 * their markdown to recover the full title and infer the workspace directory.
 * All fetches run in parallel with a cap to avoid hammering the API.
 */
async function enrichThreadRecords(
  account: StoredAccount,
  records: ThreadRecord[],
): Promise<ThreadRecord[]> {
  const truncated = records.filter((r) => r.title.endsWith("..."));
  if (truncated.length === 0) return records;

  const CONCURRENCY = 5;
  const enriched = new Map<string, { fullTitle?: string; workspaceDir?: string; updatedAtMs?: number }>();

  // Process in batches of CONCURRENCY
  for (let i = 0; i < truncated.length; i += CONCURRENCY) {
    const batch = truncated.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (rec) => {
        try {
          const result = await runAmp(account, ["threads", "markdown", rec.id], 30_000);
          if (result.code === 0) {
            // Only parse the first 2 KB — we just need the frontmatter + a few content lines
            const preview = result.stdout.slice(0, 2048);
            enriched.set(rec.id, extractMarkdownMeta(preview));
          }
        } catch {
          // Silently skip — we fall back to the truncated title
        }
      }),
    );
  }

  return records.map((rec) => {
    const meta = enriched.get(rec.id);
    if (!meta) return rec;
    return {
      ...rec,
      title: meta.fullTitle ?? rec.title,
      workspaceDir: meta.workspaceDir,
      updatedAtMs: meta.updatedAtMs ?? rec.updatedAtMs,
    };
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
    const records = parseThreadsListOutput(cleaned);
    // Enrich truncated titles and infer workspace dirs in the background
    return enrichThreadRecords(account, records);
  });

  ipcMain.handle("threads:markdown", async (_event, payload: { accountId: string; threadId: string }): Promise<string> => {
    const account = getStoredAccountOrThrow(payload.accountId);
    const result = await runAmp(account, ["threads", "markdown", payload.threadId], 180_000);
    return ensureSuccess(result, "Fetch thread markdown");
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
