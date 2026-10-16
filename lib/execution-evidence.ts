import path from 'node:path';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid execution record');
  return value as RecordValue;
}

function list(value: unknown, limit = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid execution list');
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid execution identity');
  return value;
}

// Cross-check the reporter inventory with independent Playwright JSON results.
// Imported helpers are source dependencies, never evidence that a helper executed.
export function inspectExecution(
  reportValue: unknown,
  executionValue: unknown,
  options: { target: string; project: string },
) {
  let testCount = 0;
  let accepted = true;
  try {
    const report = record(reportValue);
    const execution = record(executionValue);
    if (
      execution.schemaVersion !== 1 ||
      execution.complete !== true ||
      execution.status !== 'passed' ||
      execution.errorCount !== 0 ||
      (report.errors !== undefined && list(report.errors).length > 0)
    )
      accepted = false;

    const planned = list(execution.planned);
    const results = list(execution.results, 20_000);
    if (planned.length === 0 || results.length !== planned.length) accepted = false;
    const rootDir = text(record(report.config).rootDir);
    const specs = new Map<string, RecordValue>();
    const visit = (suiteValue: unknown, depth: number) => {
      if (depth > 100) throw new Error('Invalid execution nesting');
      const suite = record(suiteValue);
      for (const value of list(suite.specs ?? [])) {
        const spec = record(value);
        const id = text(spec.id);
        if (specs.has(id) || specs.size >= 10_000) throw new Error('Duplicate test identity');
        specs.set(id, spec);
      }
      for (const child of list(suite.suites ?? [])) visit(child, depth + 1);
    };
    visit(report, 0);
    if (specs.size !== planned.length) accepted = false;
    const seenTests = new Set<string>();
    const resultById = new Map<string, RecordValue[]>();
    for (const value of results) {
      const result = record(value);
      const id = text(result.testId);
      const attempts = resultById.get(id) ?? [];
      attempts.push(result);
      resultById.set(id, attempts);
    }
    for (const value of planned) {
      const plan = record(value);
      const id = text(plan.testId);
      if (seenTests.has(id)) throw new Error('Duplicate planned test');
      seenTests.add(id);
      const spec = specs.get(id);
      const outcomes = resultById.get(id);
      if (!spec || !outcomes || outcomes.length !== 1) {
        accepted = false;
        continue;
      }
      const outcome = outcomes[0];
      if (
        plan.project !== options.project ||
        outcome.project !== options.project ||
        path.resolve(text(plan.file)) !== options.target ||
        path.resolve(text(outcome.file)) !== options.target ||
        path.resolve(rootDir, text(spec.file)) !== options.target
      )
        throw new Error('Test selection mismatch');
      const tests = list(spec.tests);
      if (tests.length !== 1) throw new Error('Ambiguous test project');
      const test = record(tests[0]);
      const attempts = list(test.results);
      if (attempts.length !== 1) {
        accepted = false;
        continue;
      }
      const attempt = record(attempts[0]);
      if (
        plan.expectedStatus !== 'passed' ||
        outcome.expectedStatus !== 'passed' ||
        outcome.retry !== 0 ||
        outcome.status !== 'passed' ||
        test.projectName !== options.project ||
        test.expectedStatus !== 'passed' ||
        test.status !== 'expected' ||
        attempt.retry !== 0 ||
        attempt.status !== 'passed'
      )
        accepted = false;
    }
    testCount = planned.length;
    if ([...resultById.keys()].some((id) => !seenTests.has(id))) accepted = false;
  } catch {
    // Missing, truncated or inconsistent reports never turn into passing evidence.
    accepted = false;
  }
  return { accepted, testCount: accepted ? testCount : 0 };
}
