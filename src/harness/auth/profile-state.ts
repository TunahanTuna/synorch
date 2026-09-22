import path from "node:path";
import { credentialAccountKey, type CredentialRef } from "../contracts/index.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { KeyedMutex } from "./locks.ts";

export const PROFILE_STATE_FILE_NAME = "auth-state.json";

interface StateFile {
  schema_version: 1;
  /** Profiles whose refresh failed permanently; the secret is kept, but a new login is required. */
  login_required: Record<string, { since: string; reason: string }>;
  /** One-time notice acknowledgements, per notice id and profile account key. */
  acknowledged: Record<string, Record<string, string>>;
}

/**
 * Non-secret per-profile state in `<home>/auth-state.json`: the `login_required` marker set by a
 * permanent refresh failure and the one-time notice acknowledgements. Never holds a token.
 */
export class ProfileStateStore {
  private readonly filePath: string | undefined;
  private memory: StateFile = empty();
  private readonly mutex = new KeyedMutex();

  /** `home === undefined` keeps state in memory only. */
  public constructor(home: string | undefined) {
    this.filePath = home === undefined ? undefined : path.join(home, PROFILE_STATE_FILE_NAME);
  }

  public async loginRequired(ref: CredentialRef): Promise<{ readonly since: string; readonly reason: string } | undefined> {
    return (await this.load()).login_required[credentialAccountKey(ref)];
  }

  public async markLoginRequired(ref: CredentialRef, reason: string, at: Date): Promise<void> {
    await this.update((state) => {
      state.login_required[credentialAccountKey(ref)] = { since: at.toISOString(), reason: reason.slice(0, 200) };
    });
  }

  public async clearLoginRequired(ref: CredentialRef): Promise<void> {
    await this.update((state) => {
      delete state.login_required[credentialAccountKey(ref)];
    });
  }

  public async isAcknowledged(noticeId: string, ref: CredentialRef): Promise<boolean> {
    return (await this.load()).acknowledged[noticeId]?.[credentialAccountKey(ref)] !== undefined;
  }

  public async acknowledge(noticeId: string, ref: CredentialRef, at: Date): Promise<void> {
    await this.update((state) => {
      state.acknowledged[noticeId] = { ...(state.acknowledged[noticeId] ?? {}), [credentialAccountKey(ref)]: at.toISOString() };
    });
  }

  public async revokeAcknowledgement(noticeId: string, ref: CredentialRef): Promise<void> {
    await this.update((state) => {
      const entries = state.acknowledged[noticeId];
      if (entries !== undefined) delete entries[credentialAccountKey(ref)];
    });
  }

  private async load(): Promise<StateFile> {
    if (this.filePath === undefined) return structuredClone(this.memory);
    try {
      const raw = (await readJsonFile(this.filePath)) as Partial<StateFile> | undefined;
      if (raw?.schema_version !== 1) return empty();
      return {
        schema_version: 1,
        login_required: typeof raw.login_required === "object" && raw.login_required !== null ? raw.login_required : {},
        acknowledged: typeof raw.acknowledged === "object" && raw.acknowledged !== null ? raw.acknowledged : {},
      };
    } catch {
      return empty();
    }
  }

  private async update(mutate: (state: StateFile) => void): Promise<void> {
    await this.mutex.run("state", async () => {
      const state = await this.load();
      mutate(state);
      if (this.filePath === undefined) this.memory = state;
      else await writeJsonAtomic(this.filePath, state);
    });
  }
}

function empty(): StateFile {
  return { schema_version: 1, login_required: {}, acknowledged: {} };
}
