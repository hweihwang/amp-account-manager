import { contextBridge, ipcRenderer } from "electron";
import type {
  AmpAccount,
  AmpAccountUpsertPayload,
  AmpPreloadApi,
  DoctorCheck,
  ThreadRecord,
  UsageSnapshot,
} from "../shared/ipc";

const api: AmpPreloadApi = {
  accounts: {
    list(): Promise<AmpAccount[]> {
      return ipcRenderer.invoke("accounts:list");
    },
    upsert(payload: AmpAccountUpsertPayload): Promise<AmpAccount> {
      return ipcRenderer.invoke("accounts:upsert", payload);
    },
    remove(accountId: string): Promise<void> {
      return ipcRenderer.invoke("accounts:remove", accountId);
    },
    activate(accountId: string): Promise<void> {
      return ipcRenderer.invoke("accounts:activate", accountId);
    },
    getActiveId(): Promise<string | null> {
      return ipcRenderer.invoke("accounts:getActiveId");
    },
    loginWithBrowser(): Promise<AmpAccount> {
      return ipcRenderer.invoke("accounts:loginWithBrowser");
    },
    cancelBrowserLogin(): Promise<void> {
      return ipcRenderer.invoke("accounts:cancelBrowserLogin");
    },
  },
  usage: {
    get(accountId: string): Promise<UsageSnapshot> {
      return ipcRenderer.invoke("usage:get", accountId);
    },
  },
  threads: {
    list(accountId: string): Promise<ThreadRecord[]> {
      return ipcRenderer.invoke("threads:list", accountId);
    },
    markdown(payload: { accountId: string; threadId: string }): Promise<string> {
      return ipcRenderer.invoke("threads:markdown", payload);
    },
  },
  app: {
    openExternal(url: string): Promise<void> {
      return ipcRenderer.invoke("app:openExternal", url);
    },
  },
  doctor: {
    run(): Promise<DoctorCheck[]> {
      return ipcRenderer.invoke("doctor:run");
    },
  },
};

contextBridge.exposeInMainWorld("ampManager", api);
