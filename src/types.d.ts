import type { AmpPreloadApi } from "../shared/ipc";

declare global {
  interface Window {
    ampManager: AmpPreloadApi;
  }
}

export {};
