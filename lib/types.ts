import type { EventEmitter } from 'node:events';

export type TraceMode = 'off' | 'on' | 'retain-on-failure';
export type CauseCode =
  | 'LEASE_REFUSED'
  | 'PRESSURE_REFUSED'
  | 'CANCELLED'
  | 'SUITE_TIMEOUT'
  | 'SPAWN_FAILED'
  | 'TEST_FAILED'
  | 'REPORT_UNAVAILABLE'
  | 'SELECTION_MISMATCH'
  | 'TRACE_OFF_UNVERIFIED'
  | 'CLEANUP_UNRESOLVED'
  | 'SETUP_FAILED';

export interface SuiteOptions {
  config: string;
  target: string;
  checkout: string;
  project: string;
  timeout: number;
  workers: number;
  locks: string[];
  output?: string;
  trace?: TraceMode;
  timings?: boolean;
  captureOutput?: boolean;
  verification?: { workspace: string };
}

export interface PressureObservation {
  safe: boolean;
  source?: string;
  level?: number | null;
  availableMiB?: number | null;
  requiredMiB?: number;
  reason?: string;
  code?: string | null;
}

export interface ChildOutcome {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export interface OwnedChild extends EventEmitter {
  pid?: number;
}
export interface GroupCleanup {
  complete: boolean;
  childReaped?: boolean;
  groupAbsent?: boolean;
  signals?: NodeJS.Signals[];
  error?: string | null;
  probeErrors?: { phase: string; code: string }[];
}
export interface BrowserCleanup {
  complete: boolean;
  registered?: number[];
  remainingGroups?: number[];
  retirements?: {
    pid: number;
    signals: NodeJS.Signals[];
    childReaped: null;
    groupAbsent?: boolean;
    complete?: boolean;
  }[];
  reason?: string;
}
export interface CleanupReceipt extends GroupCleanup {
  custodyAcquired: boolean;
  pid?: number | null;
  browsers?: BrowserCleanup;
  reason?: string;
  spawnError?: string | null;
  leaseReleaseError?: string;
}

export interface TestStats {
  expected: number;
  unexpected: number;
  skipped?: number;
  flaky?: number;
  duration?: number;
}
export interface TestResult extends ChildOutcome {
  verdict: 'not-run' | 'passed' | 'failed' | 'aborted';
  reason?: string;
  reportError?: string;
  stats?: TestStats;
  selected?: { file: string; project: string }[];
}
export interface RunSummary {
  started: string;
  finished?: string;
  config: string;
  target: string;
  checkout: string;
  project?: string;
  workers: number;
  output: string;
  agentInvocations: 0;
  test: TestResult;
  cleanup: CleanupReceipt;
  pressure: PressureObservation[];
  phaseMs?: Record<string, number>;
  trace?: {
    requested: TraceMode | 'project-config';
    effective: string | null;
    artifactPresent?: boolean;
    guardFailure?: string;
  };
  causeCode?: CauseCode;
  error?: string;
}
