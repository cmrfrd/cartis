/** Scenario contract — verbatim from the test-hardening spec §Track C. */

export interface Scenario {
  id: string;
  title: string;
  timeoutMin: number;
  /** e2e/agentic/fixtures/<name> dir copied into the scratch data root. */
  seed?: string;
  /** Repo-relative files copied into the scratch stage dir. */
  stage?: readonly string[];
  /** User-voice; {{APP_URL}} / {{STAGE_DIR}} templated. */
  objective: string;
  constraints: readonly string[];
  criteria: readonly Criterion[];
}

export type Criterion =
  | { kind: 'fs'; label: string; check: (dataRoot: string) => boolean | Promise<boolean> }
  | { kind: 'page'; label: string; script: string; expect: (result: unknown) => boolean };

export interface Verdict {
  scenario: string;
  driverOutcome: 'done' | 'blocked' | 'timeout';
  results: { label: string; pass: boolean; evidence: string }[];
  driverReply: string;
}
