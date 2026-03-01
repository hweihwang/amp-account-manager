export type AmpAccount = {
  id: string;
  email: string;
  createdAt: number;
  updatedAt: number;
  hasApiKey: boolean;
};

export type AmpAccountUpsertPayload = {
  id?: string;
  email?: string;
  apiKey?: string;
};

export type UsageSnapshot = {
  signedInAs: string | null;
  ampFreeRemaining: number | null;
  ampFreeLimit: number | null;
  replenishesPerHour: number | null;
  individualCredits: number | null;
  rawOutput: string;
  fetchedAt: number;
};

export type ThreadRecord = {
  id: string;
  title: string;
  lastUpdated: string;
  visibility: string;
  messages: number;
  /** Unix ms timestamp from the thread's updatedAt field — used for sorting */
  updatedAtMs: number;
  /** Workspace/project directory inferred from thread content, e.g. "amp-account-manager" */
  workspaceDir?: string;
};

export type DoctorCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  message: string;
  fix?: string;
};

export type AmpPreloadApi = {
  accounts: {
    list(): Promise<AmpAccount[]>;
    upsert(payload: AmpAccountUpsertPayload): Promise<AmpAccount>;
    remove(accountId: string): Promise<void>;
    activate(accountId: string): Promise<void>;
    getActiveId(): Promise<string | null>;
    loginWithBrowser(): Promise<AmpAccount>;
    cancelBrowserLogin(): Promise<void>;
  };
  usage: {
    get(accountId: string): Promise<UsageSnapshot>;
  };
  threads: {
    list(accountId: string): Promise<ThreadRecord[]>;
    markdown(payload: { accountId: string; threadId: string }): Promise<string>;
  };
  app: {
    openExternal(url: string): Promise<void>;
  };
  doctor: {
    run(): Promise<DoctorCheck[]>;
  };
};
