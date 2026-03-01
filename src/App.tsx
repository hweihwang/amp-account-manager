import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AmpAccount,
  DoctorCheck,
  ThreadRecord,
  UsageSnapshot,
} from "../shared/ipc";

// ─── helpers ────────────────────────────────────────────────────────────────

type NoticeTone = "info" | "success" | "error";
type NoticeState = { tone: NoticeTone; message: string } | null;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unexpected error";
}

function formatMoney(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "–";
  return `$${value.toFixed(2)}`;
}

/** Derive a "project group" from a thread's workspace dir or title heuristic */
function inferProjectGroup(thread: ThreadRecord): string {
  // Prefer the explicit workspace dir resolved by the backend
  if (thread.workspaceDir) return thread.workspaceDir;

  const title = thread.title;

  // [bracket-tag] prefix
  const bracketMatch = title.match(/^\[([^\]]{1,40})\]/);
  if (bracketMatch) return bracketMatch[1].trim();

  // "word:" prefix (e.g. "project-name: fix bug")
  const colonMatch = title.match(/^([A-Za-z0-9_.\-/ ]{1,30}):/);
  if (colonMatch) return colonMatch[1].trim();

  // "word/word" path-like prefix
  const slashMatch = title.match(/^([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)/);
  if (slashMatch) return slashMatch[1].trim();

  // No project context — use the thread title so it sorts naturally
  return thread.title || thread.id;
}

function usageFraction(usage: UsageSnapshot | undefined): number {
  if (!usage) return 0;
  const remaining = usage.ampFreeRemaining ?? 0;
  const limit = usage.ampFreeLimit;
  if (!limit || limit <= 0) return 0;
  return Math.min(1, Math.max(0, remaining / limit));
}

function formatRelativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function usageColor(fraction: number): string {
  if (fraction > 0.5) return "var(--status-success)";
  if (fraction > 0.2) return "var(--status-warn)";
  return "var(--status-error)";
}

// ─── component ───────────────────────────────────────────────────────────────

export default function App() {
  const [notice, setNotice] = useState<NoticeState>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [busyKey, setBusyKey] = useState("");

  const [accounts, setAccounts] = useState<AmpAccount[]>([]);
  const [usageByAccount, setUsageByAccount] = useState<Record<string, UsageSnapshot>>({});
  const [usageLoadingIds, setUsageLoadingIds] = useState<Set<string>>(new Set());

  const [activeAccountId, setActiveAccountId] = useState("");   // shell-synced active account
  const [browsedAccountId, setBrowsedAccountId] = useState(""); // account whose threads are shown in pane 2/3
  const [threadsOwnerAccountId, setThreadsOwnerAccountId] = useState("");
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [threadFilter, setThreadFilter] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");

  // Thread content (markdown) fetch
  const [threadMarkdown, setThreadMarkdown] = useState("");
  const [threadMarkdownLoading, setThreadMarkdownLoading] = useState(false);

  // Doctor state
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctorChecks, setDoctorChecks] = useState<DoctorCheck[]>([]);
  const [doctorLoading, setDoctorLoading] = useState(false);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState("");
  const [accountApiKey, setAccountApiKey] = useState("");
  const [loginMode, setLoginMode] = useState<"browser" | "manual">("browser");

  // Groups that the user has manually collapsed
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const activeAccount = useMemo(
    () => accounts.find((a) => a.id === activeAccountId) ?? null,
    [accounts, activeAccountId],
  );
  const activeUsage = activeAccountId ? usageByAccount[activeAccountId] : undefined;

  // Build sorted group → threads map
  const threadGroups = useMemo(() => {
    const map = new Map<string, ThreadRecord[]>();
    for (const thread of threads) {
      const group = inferProjectGroup(thread);
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(thread);
    }
    // Sort threads within each group: most recently updated first
    for (const items of map.values()) {
      items.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    }
    // Sort groups by their most-recently-updated thread
    return [...map.entries()].sort((a, b) => {
      return b[1][0].updatedAtMs - a[1][0].updatedAtMs;
    });
  }, [threads]);

  // When search is active: flat filtered list across all groups.
  // When no search: grouped view respecting collapsedGroups.
  const keyword = threadFilter.trim().toLowerCase();
  const isSearching = keyword.length > 0;

  const groupedView = useMemo(() => {
    if (isSearching) {
      const matches = threads
        .filter(
          (t) =>
            t.title.toLowerCase().includes(keyword) ||
            t.id.toLowerCase().includes(keyword),
        )
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      return [{ group: "", threads: matches }];
    }
    return threadGroups.map(([group, items]) => ({ group, threads: items }));
  }, [isSearching, keyword, threads, threadGroups]);

  const totalVisible = useMemo(
    () => groupedView.reduce((n, g) => n + g.threads.length, 0),
    [groupedView],
  );

  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );

  // ── notice auto-dismiss ────────────────────────────────────────────────────

  function showNotice(tone: NoticeTone, message: string) {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice({ tone, message });
    noticeTimerRef.current = setTimeout(() => setNotice(null), 3800);
  }

  // ── thread context reset ───────────────────────────────────────────────────

  function resetThreadContext(): void {
    setBrowsedAccountId("");
    setThreads([]);
    setThreadsOwnerAccountId("");
    setThreadFilter("");
    setSelectedThreadId("");
    setThreadMarkdown("");
    setCollapsedGroups(new Set());
  }

  // ── accounts ──────────────────────────────────────────────────────────────

  async function refreshAccounts(silent = false): Promise<void> {
    try {
      const [nextAccounts, shellActiveId] = await Promise.all([
        window.ampManager.accounts.list(),
        window.ampManager.accounts.getActiveId(),
      ]);
      setAccounts(nextAccounts);

      if (!nextAccounts.length) {
        setActiveAccountId("");
        resetThreadContext();
        return;
      }

      // Prefer shell as source of truth; fall back to current selection or first account
      const resolvedId =
        (shellActiveId && nextAccounts.some((a) => a.id === shellActiveId) ? shellActiveId : null) ??
        (nextAccounts.some((a) => a.id === activeAccountId) ? activeAccountId : null) ??
        nextAccounts[0].id;

      setActiveAccountId(resolvedId);
      // Seed the browsed account to the active one if nothing is browsed yet
      setBrowsedAccountId((cur) =>
        cur && nextAccounts.some((a) => a.id === cur) ? cur : resolvedId
      );
    } catch (error) {
      if (!silent) showNotice("error", toErrorMessage(error));
    }
  }

  useEffect(() => {
    void refreshAccounts();
  }, []);

  useEffect(() => {
    if (!selectedThreadId) return;
    if (threads.some((t) => t.id === selectedThreadId)) return;
    setSelectedThreadId(threads[0]?.id ?? "");
  }, [threads, selectedThreadId]);

  // ── usage ─────────────────────────────────────────────────────────────────

  async function loadUsage(accountId: string, silent = false): Promise<void> {
    if (!accountId) return;
    setUsageLoadingIds((prev) => { const s = new Set(prev); s.add(accountId); return s; });
    try {
      const usage = await window.ampManager.usage.get(accountId);
      setUsageByAccount((cur) => ({ ...cur, [accountId]: usage }));
      if (!silent) showNotice("info", `Usage refreshed for ${usage.signedInAs ?? "account"}.`);
    } catch (error) {
      if (!silent) showNotice("error", toErrorMessage(error));
    } finally {
      setUsageLoadingIds((prev) => { const s = new Set(prev); s.delete(accountId); return s; });
    }
  }

  async function refreshAllUsage(): Promise<void> {
    if (!accounts.length) { showNotice("error", "No accounts available."); return; }
    setBusyKey("usage-all");
    try {
      const snapshots = await Promise.all(
        accounts.map(async (a) => ({ accountId: a.id, usage: await window.ampManager.usage.get(a.id) })),
      );
      setUsageByAccount((cur) => {
        const next = { ...cur };
        for (const s of snapshots) next[s.accountId] = s.usage;
        return next;
      });
      showNotice("success", `Usage refreshed for ${snapshots.length} account(s).`);
    } catch (error) {
      showNotice("error", toErrorMessage(error));
    } finally {
      setBusyKey("");
    }
  }

  // ── threads ───────────────────────────────────────────────────────────────

  async function loadThreads(accountId: string, silent = false): Promise<void> {
    if (!accountId) return;
    setBusyKey(`threads-${accountId}`);
    try {
      const nextThreads = await window.ampManager.threads.list(accountId);
      setThreads(nextThreads);
      setThreadsOwnerAccountId(accountId);
      setSelectedThreadId(nextThreads[0]?.id ?? "");
      setCollapsedGroups(new Set());
      if (!silent) showNotice("success", `Loaded ${nextThreads.length} threads.`);
    } catch (error) {
      if (!silent) showNotice("error", toErrorMessage(error));
    } finally {
      setBusyKey("");
    }
  }

  // Auto-load threads whenever the browsed account changes
  useEffect(() => {
    if (!browsedAccountId) return;
    void loadThreads(browsedAccountId, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsedAccountId]);

  // Auto-load usage for all accounts once on startup (silently, in parallel)
  const usageBootstrappedRef = useRef(false);
  useEffect(() => {
    if (accounts.length === 0) return;
    if (usageBootstrappedRef.current) return;
    usageBootstrappedRef.current = true;
    for (const account of accounts) {
      void loadUsage(account.id, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  // ── thread markdown ───────────────────────────────────────────────────────

  const loadThreadMarkdown = useCallback(async (accountId: string, threadId: string) => {
    if (!accountId || !threadId) return;
    setThreadMarkdown("");
    setThreadMarkdownLoading(true);
    try {
      const md = await window.ampManager.threads.markdown({ accountId, threadId });
      setThreadMarkdown(md);
    } catch (error) {
      showNotice("error", toErrorMessage(error));
    } finally {
      setThreadMarkdownLoading(false);
    }
  }, []);

  // Auto-fetch markdown when thread is selected
  useEffect(() => {
    if (!selectedThreadId || !browsedAccountId) return;
    void loadThreadMarkdown(browsedAccountId, selectedThreadId);
  }, [selectedThreadId, browsedAccountId, loadThreadMarkdown]);

  // ── activate account ──────────────────────────────────────────────────────

  async function activateAccount(accountId: string): Promise<void> {
    if (!accountId) return;
    if (accountId === activeAccountId) return;

    setActiveAccountId(accountId);
    setBrowsedAccountId(accountId);
    // Sync the active account's API key to ~/.zshrc so `amp` CLI in the
    // terminal automatically picks up the right account.
    try {
      await window.ampManager.accounts.activate(accountId);
    } catch {
      // Non-fatal — UI switch still succeeds even if shell sync fails
    }
    // resetThreadContext is called inside loadThreads via the autoload effect;
    // we still kick off usage in parallel here.
    await loadUsage(accountId, true);
    showNotice("success", "Account switched.");
  }

  // ── copy ──────────────────────────────────────────────────────────────────

  function onCopy(text: string, label: string): void {
    if (!text.trim()) { showNotice("error", `${label} is empty.`); return; }
    void navigator.clipboard.writeText(text)
      .then(() => showNotice("success", `${label} copied to clipboard.`))
      .catch((error) => showNotice("error", toErrorMessage(error)));
  }

  // ── doctor ────────────────────────────────────────────────────────────────

  async function runDoctor(): Promise<void> {
    setDoctorOpen(true);
    setDoctorLoading(true);
    try {
      const checks = await window.ampManager.doctor.run();
      setDoctorChecks(checks);
    } catch (error) {
      showNotice("error", toErrorMessage(error));
    } finally {
      setDoctorLoading(false);
    }
  }

  // ── account form ──────────────────────────────────────────────────────────

  function openAddDrawer() {
    setEditingAccountId("");
    setAccountApiKey("");
    setLoginMode("browser");
    setDrawerOpen(true);
  }

  function openEditDrawer(account: AmpAccount) {
    setEditingAccountId(account.id);
    setAccountApiKey("");
    setLoginMode("manual");
    setDrawerOpen(true);
  }

  function closeDrawer() {
    // Cancel any in-flight browser login
    if (busyKey === "account-browser-login") {
      void window.ampManager.accounts.cancelBrowserLogin();
    }
    setDrawerOpen(false);
    setEditingAccountId("");
    setAccountApiKey("");
    setLoginMode("browser");
    setBusyKey("");
  }

  async function onSaveAccount(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!editingAccountId && !accountApiKey.trim()) { showNotice("error", "API key is required."); return; }
    setBusyKey("account-save");
    try {
      const saved = await window.ampManager.accounts.upsert({
        id: editingAccountId || undefined,
        apiKey: accountApiKey.trim() || undefined,
      });
      closeDrawer();
      await refreshAccounts(true);
      await activateAccount(saved.id);
      showNotice("success", `${editingAccountId ? "Updated" : "Added"} account: ${saved.email}`);
    } catch (error) {
      showNotice("error", toErrorMessage(error));
    } finally {
      setBusyKey("");
    }
  }

  async function onLoginWithBrowser(): Promise<void> {
    setBusyKey("account-browser-login");
    try {
      const saved = await window.ampManager.accounts.loginWithBrowser();
      closeDrawer();
      await refreshAccounts(true);
      await activateAccount(saved.id);
      showNotice("success", `Logged in as ${saved.email}`);
    } catch (error) {
      // Don't show error toast if user intentionally cancelled
      const msg = toErrorMessage(error);
      if (msg !== "Login cancelled.") showNotice("error", msg);
    } finally {
      setBusyKey("");
    }
  }

  async function onDeleteAccount(account: AmpAccount): Promise<void> {
    setBusyKey(`account-delete-${account.id}`);
    try {
      await window.ampManager.accounts.remove(account.id);
      await refreshAccounts(true);
      if (activeAccountId === account.id) {
        const remaining = await window.ampManager.accounts.list();
        if (remaining[0]) await activateAccount(remaining[0].id);
        else { setActiveAccountId(""); resetThreadContext(); }
      } else if (browsedAccountId === account.id) {
        // Was browsing deleted account but it wasn't active — just stop browsing it
        setBrowsedAccountId(activeAccountId);
      }
      showNotice("info", `Removed: ${account.email}`);
    } catch (error) {
      showNotice("error", toErrorMessage(error));
    } finally {
      setBusyKey("");
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  const threadsLoaded = threadsOwnerAccountId === browsedAccountId;
  const threadsLoading = busyKey === `threads-${browsedAccountId}`;
  const usageLoading = busyKey === `usage-${activeAccountId}` || busyKey === "usage-all";

  return (
    <div className="root">
      {/* ── DRAWER OVERLAY ─────────────────────────────────────────────── */}
      {drawerOpen && (
        <div className="drawer-overlay" onClick={closeDrawer}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <span className="drawer-title">
                {editingAccountId ? "Edit Account" : "Add Account"}
              </span>
              <button className="icon-btn" onClick={closeDrawer} aria-label="Close">
                <CloseIcon />
              </button>
            </div>

            <form className="drawer-form" onSubmit={(e) => void onSaveAccount(e)}>
              {!editingAccountId && (
                <div className="login-mode-tabs">
                  <button
                    type="button"
                    className={`login-mode-tab${loginMode === "browser" ? " login-mode-tab--active" : ""}`}
                    onClick={() => setLoginMode("browser")}
                    disabled={busyKey === "account-browser-login"}
                  >
                    Login with Browser
                  </button>
                  <button
                    type="button"
                    className={`login-mode-tab${loginMode === "manual" ? " login-mode-tab--active" : ""}`}
                    onClick={() => setLoginMode("manual")}
                    disabled={busyKey === "account-browser-login"}
                  >
                    Enter API Key
                  </button>
                </div>
              )}

              {loginMode === "manual" && (
                <div className="field">
                  <label className="field-label">
                    API Key
                    {editingAccountId && (
                      <span className="field-hint"> — leave blank to keep existing</span>
                    )}
                  </label>
                  <input
                    className="field-input"
                    value={accountApiKey}
                    onChange={(e) => setAccountApiKey(e.target.value)}
                    placeholder={editingAccountId ? "Leave blank to keep current key" : "sgamp_user_..."}
                    type="password"
                    autoComplete="off"
                    autoFocus
                  />
                </div>
              )}

              {loginMode === "browser" && !editingAccountId && (
                busyKey === "account-browser-login" ? (
                  <div className="browser-login-waiting">
                    <Spinner />
                    <span>Waiting for browser login…</span>
                  </div>
                ) : (
                  <div className="browser-login-info">
                    <p>Your browser will open to ampcode.com to sign in. Your account will be identified by your email.</p>
                  </div>
                )
              )}

              <div className="drawer-footer">
                {busyKey === "account-browser-login" ? (
                  <button type="button" className="btn btn-ghost" onClick={closeDrawer}>
                    Cancel Login
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost" onClick={closeDrawer}>
                    Cancel
                  </button>
                )}
                {loginMode === "browser" && !editingAccountId ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void onLoginWithBrowser()}
                    disabled={busyKey === "account-browser-login"}
                  >
                    {busyKey === "account-browser-login" ? "Waiting…" : "Open Browser to Login"}
                  </button>
                ) : (
                  <button className="btn btn-primary" type="submit" disabled={busyKey === "account-save"}>
                    {busyKey === "account-save" ? "Saving…" : editingAccountId ? "Save Changes" : "Add Account"}
                  </button>
                )}
              </div>
            </form>
          </aside>
        </div>
      )}

      {/* ── DOCTOR OVERLAY ────────────────────────────────────────────── */}
      {doctorOpen && (
        <div className="drawer-overlay" onClick={() => setDoctorOpen(false)}>
          <aside className="doctor-panel" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <span className="drawer-title">System Doctor</span>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => void runDoctor()}
                  disabled={doctorLoading}
                  title="Re-run checks"
                >
                  <RefreshIcon spinning={doctorLoading} />
                </button>
                <button className="icon-btn" onClick={() => setDoctorOpen(false)} aria-label="Close">
                  <CloseIcon />
                </button>
              </div>
            </div>

            <div className="doctor-body">
              {doctorLoading && doctorChecks.length === 0 ? (
                <div className="loading-state">
                  <Spinner />
                  <span>Running diagnostics…</span>
                </div>
              ) : (
                <div className="doctor-checks">
                  {doctorChecks.map((check) => (
                    <div key={check.id} className={`doctor-check doctor-check--${check.status}`}>
                      <span className="doctor-check-icon">
                        {check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "⚠"}
                      </span>
                      <div className="doctor-check-content">
                        <div className="doctor-check-label">{check.label}</div>
                        <div className="doctor-check-message">{check.message}</div>
                        {check.fix && (
                          <div className="doctor-check-fix">
                            <strong>Fix:</strong> {check.fix}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {doctorChecks.length > 0 && !doctorChecks.some((c) => c.status === "fail") && (
                    <div className="doctor-all-good">
                      All checks passed — your system is ready to go.
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* ── TOAST ──────────────────────────────────────────────────────── */}
      {notice && (
        <div className={`toast toast-${notice.tone}`} role="status">
          <span className="toast-dot" />
          <span>{notice.message}</span>
          <button className="toast-close icon-btn" onClick={() => setNotice(null)}>
            <CloseIcon />
          </button>
        </div>
      )}

      {/* ── TOPBAR ─────────────────────────────────────────────────────── */}
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="18" height="18">
              <defs>
                <linearGradient id="brand-bg" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#7c3aed" />
                  <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
              </defs>
              <rect width="512" height="512" rx="112" ry="112" fill="url(#brand-bg)" />
              <text x="256" y="310" fontFamily="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif" fontSize="288" fontWeight="700" fill="white" textAnchor="middle" letterSpacing="-8">A</text>
              <rect x="148" y="358" width="18" height="28" rx="9" fill="white" opacity="0.55"/>
              <rect x="178" y="342" width="18" height="44" rx="9" fill="white" opacity="0.75"/>
              <rect x="208" y="330" width="18" height="56" rx="9" fill="white" opacity="0.90"/>
              <rect x="238" y="320" width="18" height="66" rx="9" fill="white" opacity="1.00"/>
              <rect x="268" y="330" width="18" height="56" rx="9" fill="white" opacity="0.90"/>
              <rect x="298" y="342" width="18" height="44" rx="9" fill="white" opacity="0.75"/>
              <rect x="328" y="358" width="18" height="28" rx="9" fill="white" opacity="0.55"/>
            </svg>
          </div>
          <span className="brand-name">Amp Account Manager</span>
        </div>

        <div className="topbar-divider" aria-hidden="true" />

        <div className="topbar-active">
          {activeAccount ? (
            <>
              <span className={`status-dot ${activeUsage ? "status-ok" : "status-idle"}`} />
              <span className="topbar-active-label">{activeAccount.email}</span>
              {activeUsage && (
                <span className="topbar-active-balance">
                  {formatMoney(activeUsage.ampFreeRemaining)} free
                </span>
              )}
            </>
          ) : (
            <span className="topbar-no-account">No account active</span>
          )}
        </div>

        <div className="topbar-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void runDoctor()}
            title="Run system diagnostics"
          >
            <DoctorIcon />
            Doctor
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void refreshAllUsage()}
            disabled={usageLoading}
            title="Refresh usage for all accounts"
          >
            <RefreshIcon spinning={usageLoading} />
            {usageLoading ? "Refreshing…" : "Refresh Usage"}
          </button>
          <button className="btn btn-primary btn-sm" onClick={openAddDrawer}>
            <PlusIcon />
            Add Account
          </button>
        </div>
      </header>

      {/* ── THREE-PANE LAYOUT ──────────────────────────────────────────── */}
      <div className="panes">

        {/* ── PANE 1: ACCOUNTS ───────────────────────────────────────── */}
        <section className="pane pane-accounts" aria-label="Accounts">
          <div className="pane-header">
            <span className="pane-title">Accounts</span>
            <span className="pane-count">{accounts.length}</span>
          </div>

          <div className="account-list">
            {accounts.length === 0 && (
              <div className="empty-state">
                <p>No accounts yet.</p>
                <button className="btn btn-primary btn-sm" onClick={openAddDrawer}>
                  <PlusIcon /> Add your first account
                </button>
              </div>
            )}

            {accounts.map((account) => {
              const usage = usageByAccount[account.id];
              const isActive = account.id === activeAccountId;
              const isBrowsed = account.id === browsedAccountId;
              const fraction = usageFraction(usage);
              const barColor = usageColor(fraction);
              const isLoadingUsage = usageLoadingIds.has(account.id);
              const isDeleting = busyKey === `account-delete-${account.id}`;
              const isActivating = busyKey === `threads-${account.id}` && !isActive;

              return (
                <div
                  key={account.id}
                  className={`account-card ${isBrowsed ? "account-card--browsed" : ""} ${isActive ? "account-card--active" : ""}`}
                  onClick={() => setBrowsedAccountId(account.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setBrowsedAccountId(account.id); }}
                >
                  <div className="account-card-top">
                    <div className="account-card-left">
                      <div className="account-avatar" style={{ background: avatarColor(account.id) }}>
                        {account.email.charAt(0).toUpperCase()}
                      </div>
                      <div className="account-info">
                        {usage?.signedInAs ? (
                          <span className="account-label">{usage.signedInAs}</span>
                        ) : (
                          <>
                            <span className="account-label">{account.email}</span>
                            {isLoadingUsage && (
                              <span className="account-no-usage account-no-usage--loading">Loading…</span>
                            )}
                            {!isLoadingUsage && (
                              <span className="account-no-usage">Usage not loaded</span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {isActive && (
                      <span className="account-active-badge">Active</span>
                    )}
                  </div>

                  {usage && (
                    <div className="account-usage">
                      <div className="usage-bar-track">
                        <div
                          className="usage-bar-fill"
                          style={{ width: `${fraction * 100}%`, background: barColor }}
                        />
                      </div>
                      <div className="usage-numbers">
                        <span style={{ color: barColor }}>
                          {formatMoney(usage.ampFreeRemaining)} left
                        </span>
                        <span className="usage-limit">/ {formatMoney(usage.ampFreeLimit)}</span>
                        {usage.replenishesPerHour != null && usage.replenishesPerHour > 0 && (
                          <span className="usage-replenish">+{formatMoney(usage.replenishesPerHour)}/hr</span>
                        )}
                        {usage.individualCredits != null && usage.individualCredits > 0 && (
                          <span className="usage-credits">+{formatMoney(usage.individualCredits)} credits</span>
                        )}
                        <span className="usage-fetched-at">{formatRelativeTime(usage.fetchedAt)}</span>
                      </div>
                    </div>
                  )}

                  <div className="account-card-actions" onClick={(e) => e.stopPropagation()}>
                    {!isActive && (
                      <button
                        className="btn btn-ghost btn-xs account-switch-btn"
                        onClick={() => void activateAccount(account.id)}
                        disabled={isActivating}
                        title="Switch to this account"
                      >
                        {isActivating ? "Switching…" : "Switch"}
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => void loadUsage(account.id, false)}
                      disabled={isLoadingUsage}
                      title="Refresh usage"
                    >
                      <RefreshIcon spinning={isLoadingUsage} />
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => openEditDrawer(account)}
                      title="Edit account"
                    >
                      <EditIcon />
                    </button>
                    <button
                      className="btn btn-ghost btn-xs btn-danger-ghost"
                      onClick={() => void onDeleteAccount(account)}
                      disabled={isDeleting}
                      title="Remove account"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── PANE 2: THREADS ────────────────────────────────────────── */}
        <section className="pane pane-threads" aria-label="Threads">
          <div className="pane-header">
            <span className="pane-title">Threads</span>
            {threadsLoaded && (
              <span className="pane-count">{totalVisible}</span>
            )}
            <button
              className="btn btn-ghost btn-xs ml-auto"
              onClick={() => void loadThreads(browsedAccountId, false)}
              disabled={!browsedAccountId || threadsLoading}
              title="Reload threads"
            >
              <RefreshIcon spinning={threadsLoading} />
            </button>
          </div>

          {!browsedAccountId ? (
            <div className="empty-state">
              <p>Select an account to view threads.</p>
            </div>
          ) : threadsLoading ? (
            <div className="loading-state">
              <Spinner />
              <span>Loading threads…</span>
            </div>
          ) : (
            <>
              {/* Search */}
              <div className="thread-search-wrap">
                <SearchIcon />
                <input
                  className="thread-search"
                  placeholder="Search threads…"
                  value={threadFilter}
                  onChange={(e) => setThreadFilter(e.target.value)}
                />
                {threadFilter && (
                  <button className="icon-btn search-clear" onClick={() => setThreadFilter("")}>
                    <CloseIcon />
                  </button>
                )}
              </div>

              {/* Grouped thread tree */}
              <div className="thread-list">
                {totalVisible === 0 ? (
                  <div className="empty-state">
                    <p>No threads match your search.</p>
                  </div>
                ) : (
                  groupedView.map(({ group, threads: groupThreads }) => {
                    const isCollapsed = !isSearching && collapsedGroups.has(group);
                    const isSingleGroup = groupedView.length === 1;
                    return (
                      <div key={group || "__search__"} className="thread-group">
                        {/* Group header — hidden when there's only one group (single-project account or search results) */}
                        {!isSingleGroup && group && (
                          <button
                            className={`thread-group-header ${isCollapsed ? "thread-group-header--collapsed" : ""}`}
                            onClick={() => toggleGroup(group)}
                            title={isCollapsed ? "Expand" : "Collapse"}
                          >
                            <ChevronIcon collapsed={isCollapsed} />
                            <span className="thread-group-name">{group}</span>
                            <span className="thread-group-count">{groupThreads.length}</span>
                          </button>
                        )}

                        {/* Thread rows */}
                        {!isCollapsed && groupThreads.map((thread) => {
                          const isSelected = thread.id === selectedThreadId;
                          return (
                            <div
                              key={thread.id}
                              className={`thread-row ${!isSingleGroup && group ? "thread-row--indented" : ""} ${isSelected ? "thread-row--selected" : ""}`}
                              onClick={() => setSelectedThreadId(thread.id)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedThreadId(thread.id); }}
                            >
                              <div className="thread-row-title">{thread.title}</div>
                              <div className="thread-row-meta">
                                <span>{thread.lastUpdated}</span>
                                <span className="thread-dot">·</span>
                                <span>{thread.messages} msg{thread.messages !== 1 ? "s" : ""}</span>
                                {thread.visibility !== "private" && (
                                  <>
                                    <span className="thread-dot">·</span>
                                    <span className="thread-visibility">{thread.visibility}</span>
                                  </>
                                )}
                              </div>
                              <div className="thread-row-id">{thread.id}</div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </section>

        {/* ── PANE 3: THREAD DETAIL / HANDOFF ────────────────────────── */}
        <section className="pane pane-detail" aria-label="Thread detail">
          {!selectedThread ? (
            <div className="detail-empty">
              <div className="detail-empty-icon">💬</div>
              <p className="detail-empty-title">No thread selected</p>
              <p className="detail-empty-sub">
                Pick a thread on the left to view its content and copy it for handoff.
              </p>
            </div>
          ) : (
            <>
              {/* Thread meta header */}
              <div className="detail-header">
                <div className="detail-header-info">
                  <h2 className="detail-title">{selectedThread.title}</h2>
                  <div className="detail-meta">
                    <span className="detail-id">{selectedThread.id}</span>
                    <span className="thread-dot">·</span>
                    <span>{selectedThread.lastUpdated}</span>
                    <span className="thread-dot">·</span>
                    <span>{selectedThread.messages} messages</span>
                    {selectedThread.visibility !== "private" && (
                      <>
                        <span className="thread-dot">·</span>
                        <span>{selectedThread.visibility}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Handoff CTA — primary purpose */}
              <div className="handoff-strip">
                <div className="handoff-strip-left">
                  <span className="handoff-label">Rate-limit hit?</span>
                  <span className="handoff-sub">Copy this thread's full content and continue it on another account.</span>
                </div>
                <div className="handoff-strip-right">
                  {threadMarkdownLoading ? (
                    <button className="btn btn-primary btn-copy" disabled>
                      <Spinner /> Fetching…
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary btn-copy"
                      onClick={() => onCopy(threadMarkdown, "Thread content")}
                      disabled={!threadMarkdown}
                      title={!threadMarkdown ? "Content not yet loaded" : "Copy full thread markdown"}
                    >
                      <CopyIcon />
                      Copy Thread Content
                    </button>
                  )}
                </div>
              </div>

              {/* Thread content preview */}
              <div className="detail-content-wrap">
                <div className="detail-content-header">
                  <span className="detail-content-label">Thread Content</span>
                  {threadMarkdown && !threadMarkdownLoading && (
                    <span className="detail-content-size">
                      {(threadMarkdown.length / 1024).toFixed(1)} KB
                    </span>
                  )}
                  {threadMarkdownLoading && (
                    <span className="detail-content-loading">
                      <Spinner /> Loading…
                    </span>
                  )}
                </div>
                <pre className="detail-content-body">
                  {threadMarkdownLoading
                    ? "Fetching thread content…"
                    : threadMarkdown || "No content available."}
                </pre>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── icons (inline SVG, no deps) ─────────────────────────────────────────────

function DoctorIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M6.5 1v4M6.5 5h-2a1 1 0 00-1 1v1.5a3 3 0 006 0V6a1 1 0 00-1-1h-2z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 1v2h4V1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M9 1.5l2.5 2.5-7 7H2v-2.5l7-7z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <path d="M1.5 3.5h10M4.5 3.5V2.5a1 1 0 011-1h2a1 1 0 011 1v1M5.5 6v4M7.5 6v4M2.5 3.5l.75 7a1 1 0 001 .9h4.5a1 1 0 001-.9l.75-7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden="true"
      style={spinning ? { animation: "spin 0.8s linear infinite" } : undefined}
    >
      <path d="M11.5 6.5a5 5 0 11-1.5-3.5L11.5 1.5v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" className="search-icon">
      <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.5 8.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        transition: "transform 0.15s ease",
        transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
      }}
    >
      <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8.5 4.5V3a1 1 0 00-1-1h-5a1 1 0 00-1 1v5a1 1 0 001 1h1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden="true"
      style={{ animation: "spin 0.7s linear infinite" }}
    >
      <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.6" strokeOpacity="0.2" />
      <path d="M11.5 6.5a5 5 0 00-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// ─── avatar color ─────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  "#5e6ad2", "#0ea5e9", "#10b981", "#f59e0b",
  "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6",
];

function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
