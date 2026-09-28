import type { TLStoreOptions, TLStoreWithStatus } from "tldraw";

declare module "tldraw" {
  /** Runtime export of `@tldraw/editor` that tldraw 5.4 omits from its public declarations. */
  export function useLocalStore(
    options: TLStoreOptions & { persistenceKey?: string; sessionId?: string },
  ): TLStoreWithStatus;
}
