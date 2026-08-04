/**
 * Pi runtime core (migration spec §2.1/§2.3): lazily-imported pi module,
 * isolated ModelRuntime + in-memory settings, a CACHED long-lived
 * SessionManager per session (files under `<dataRoot>/chats`), and the
 * per-session in-flight map that gates all mutating routes.
 *
 * Config-reachable file: the pi module is imported DYNAMICALLY inside the
 * lazy singleton (vite's native config loader never evaluates it, and dev
 * startup stays fast when the agent is never used). All top-level pi imports
 * are TYPE-ONLY.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

type PiModule = typeof import('@earendil-works/pi-coding-agent');

export interface PiDeps {
  readonly pi: PiModule;
  readonly modelRuntime: ModelRuntime;
  readonly settings: SettingsManager;
}

export interface PiRuntime {
  readonly dataRoot: string;
  readonly chatsDir: string;
  /** Lazy singleton: pi module + isolated ModelRuntime + in-memory settings. */
  deps(): Promise<PiDeps>;
  /** Cached SessionManager for a session id — open existing file or create. */
  getSession(id: string): Promise<SessionManager>;
  /** Per-session in-flight turn gate + abort channel (spec §2.3). */
  readonly inFlight: Map<string, AgentSession>;
}

/** `CARTIS_MODEL=provider/model-id`; default kept in one place. */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';

export function parseModelRef(raw: string | undefined): { provider: string; modelId: string } {
  const value = raw !== undefined && raw.trim().length > 0 ? raw.trim() : DEFAULT_MODEL;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`CARTIS_MODEL must be "provider/model-id", got "${value}"`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/** The session file's id portion: `<timestamp>_<id>.jsonl` (timestamp has no underscores). */
function fileIdOf(fileName: string): string | undefined {
  const at = fileName.indexOf('_');
  if (at < 0 || !fileName.endsWith('.jsonl')) return undefined;
  return fileName.slice(at + 1, -'.jsonl'.length);
}

export function makePiRuntime(
  dataRoot: string,
  injected?: { modelRuntime: ModelRuntime },
): PiRuntime {
  const chatsDir = join(dataRoot, 'chats');
  let depsPromise: Promise<PiDeps> | undefined;
  const sessions = new Map<string, SessionManager>();

  const deps = (): Promise<PiDeps> => {
    depsPromise ??= (async () => {
      const pi = await import('@earendil-works/pi-coding-agent');
      const { InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
      const modelRuntime =
        injected?.modelRuntime ??
        (await pi.ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsPath: null,
        }));
      // In-memory settings: compaction OFF (entry-based rehydration must
      // never see a compaction collapse); file-backed setters are never used.
      const settings = pi.SettingsManager.inMemory({ compaction: { enabled: false } });
      return { pi, modelRuntime, settings };
    })();
    return depsPromise;
  };

  const getSession = async (id: string): Promise<SessionManager> => {
    const cached = sessions.get(id);
    if (cached !== undefined) return cached;
    const { pi } = await deps();
    let manager: SessionManager | undefined;
    // Find an existing file by its EXACT id portion (never suffix-scan).
    let files: string[] = [];
    try {
      files = readdirSync(chatsDir);
    } catch {
      // chats dir doesn't exist yet — SessionManager.create makes it.
    }
    const existing = files.find((f) => fileIdOf(f) === id);
    if (existing !== undefined) {
      manager = pi.SessionManager.open(join(chatsDir, existing), chatsDir, dataRoot);
    } else {
      // Missing file = new conversation — ALSO the clean-break path for old
      // opencode ids (a fresh pi session is minted under the same id).
      manager = pi.SessionManager.create(dataRoot, chatsDir, { id });
    }
    sessions.set(id, manager);
    return manager;
  };

  return { dataRoot, chatsDir, deps, getSession, inFlight: new Map() };
}
