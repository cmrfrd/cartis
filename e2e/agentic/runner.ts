/**
 * The agentic e2e runner (test-hardening spec §Track C).
 *
 * `bun run e2e:agent [scenario-id…] [--retries N]`
 *
 * One owner for the whole tree, per scenario sequentially: scratch dirs →
 * dev server (strict port 5199, scratch CARTIS_DATA_ROOT) → MCP/Chrome →
 * in-process pi driver → MECHANICAL verdicts (fs checks in-process; page
 * checks DIRECTLY via the harness's own MCP `evaluate_script` — never
 * relayed through the agent) → report + exit code → teardown (verified).
 *
 * Subprocesses (dev server, chrome-devtools-mcp, Chrome) exist ONLY while
 * this manual command runs; the app itself is fully in-process.
 */

import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectBrowser } from './browser.ts';
import { APP_URL, PREAMBLE, runDriver, template } from './driver.ts';
import { scenarios } from './scenarios/index.ts';
import type { Criterion, Scenario, Verdict } from './types.ts';

const PORT = 5199;
const SCRATCH_BASE = resolve('e2e/.scratch');
const RUNS_BASE = resolve('e2e/runs');

// ---------- argv ----------

const args = process.argv.slice(2);
const retriesAt = args.indexOf('--retries');
const retries = retriesAt >= 0 ? Number(args[retriesAt + 1] ?? '0') : 0;
const ids = args.filter((a, i) => a !== '--retries' && i !== retriesAt + 1);
const selected = ids.length > 0 ? scenarios.filter((s) => ids.includes(s.id)) : scenarios;
if (selected.length === 0) {
  console.error(
    `no scenarios match ${ids.join(', ')}; known: ${scenarios.map((s) => s.id).join(', ')}`,
  );
  process.exit(1);
}

// ---------- pre-flight: the port must be OURS to take ----------

const busy = await fetch(`http://localhost:${String(PORT)}/`, {
  signal: AbortSignal.timeout(1500),
}).then(
  () => true,
  () => false,
);
if (busy) {
  console.error(`ABORT: something already answers on port ${String(PORT)} — refusing to run.`);
  process.exit(1);
}

// ---------- lifecycle helpers ----------

async function startDevServer(dataRoot: string): Promise<{ kill: () => Promise<void> }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CARTIS_DATA_ROOT: dataRoot };
  delete env.REPLICATE_API_TOKEN; // stub art — zero image spend
  const child = spawn('bun', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    env,
    stdio: 'ignore',
  });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const up = await fetch(`${APP_URL}/builder`, { signal: AbortSignal.timeout(1000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('dev server did not answer within 30s');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    kill: async () => {
      child.kill();
      await exited;
      // wait for the port to actually free up before the next scenario
      const freeBy = Date.now() + 10_000;
      while (Date.now() < freeBy) {
        const up = await fetch(`${APP_URL}/`, { signal: AbortSignal.timeout(500) }).then(
          () => true,
          () => false,
        );
        if (!up) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('port 5199 still answering after kill');
    },
  };
}

/** Unwrap an MCP evaluate_script result to the returned JSON value. */
function unwrapEvaluate(content: unknown): unknown {
  const blocks = Array.isArray(content) ? (content as Array<{ type: string; text?: string }>) : [];
  const text = blocks.find((b) => b.type === 'text')?.text ?? '';
  const fenced = /```json\n([\s\S]*?)\n```/.exec(text);
  if (fenced?.[1] !== undefined) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return fenced[1];
    }
  }
  return text;
}

async function judge(
  scenario: Scenario,
  dataRoot: string,
  browser: Awaited<ReturnType<typeof connectBrowser>>,
  run: { reply: string; outcome: Verdict['driverOutcome'] },
): Promise<Verdict> {
  const results: Verdict['results'] = [];
  for (const c of scenario.criteria as readonly Criterion[]) {
    if (c.kind === 'fs') {
      try {
        const pass = await c.check(dataRoot);
        results.push({ label: c.label, pass, evidence: `fs check → ${String(pass)}` });
      } catch (error) {
        results.push({ label: c.label, pass: false, evidence: `fs check threw: ${String(error)}` });
      }
    } else {
      try {
        const raw = await browser.call('evaluate_script', { function: c.script });
        const value = unwrapEvaluate(raw);
        results.push({
          label: c.label,
          pass: c.expect(value),
          evidence: JSON.stringify(value)?.slice(0, 300) ?? 'undefined',
        });
      } catch (error) {
        results.push({
          label: c.label,
          pass: false,
          evidence: `page check threw: ${String(error)}`,
        });
      }
    }
  }
  return { scenario: scenario.id, driverOutcome: run.outcome, results, driverReply: run.reply };
}

// ---------- run ----------

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(RUNS_BASE, stamp);
mkdirSync(runDir, { recursive: true });

const verdicts: Verdict[] = [];

for (const scenario of selected) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    console.log(`\n=== ${scenario.id} (attempt ${String(attempt)}) — ${scenario.title}`);
    const scratch = join(SCRATCH_BASE, scenario.id);
    rmSync(scratch, { recursive: true, force: true });
    const dataRoot = join(scratch, 'data');
    const stageDir = join(scratch, 'stage');
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(stageDir, { recursive: true });
    if (scenario.seed !== undefined) {
      cpSync(resolve('e2e/agentic/fixtures', scenario.seed), dataRoot, { recursive: true });
    }
    for (const file of scenario.stage ?? []) {
      cpSync(resolve(file), join(stageDir, file.split('/').at(-1) ?? file));
    }

    const server = await startDevServer(dataRoot);
    const browser = await connectBrowser();
    let verdict: Verdict | undefined;
    try {
      const vars = { APP_URL, STAGE_DIR: stageDir };
      const objective = [template(scenario.objective, vars), ...scenario.constraints].join('\n');
      const run = await runDriver(
        browser,
        template(PREAMBLE, vars),
        objective,
        scenario.timeoutMin,
      );
      verdict = await judge(scenario, dataRoot, browser, run);
      // final screenshot — passed-for-the-right-reason evidence, direct.
      try {
        const shot = (await browser.call('take_screenshot', {
          filePath: join(runDir, `${scenario.id}-final.png`),
          fullPage: true,
        })) as unknown;
        void shot;
      } catch {
        // screenshot is evidence, not a verdict — tolerate failure
      }
      writeFileSync(
        join(runDir, `transcript-${scenario.id}.json`),
        JSON.stringify({ reply: run.reply, outcome: run.outcome, events: run.events }, null, 2),
      );
    } finally {
      await browser.close();
      await server.kill();
    }

    const driverFailed = verdict.driverOutcome !== 'done';
    if (driverFailed && attempt <= retries) {
      console.log(
        `driver outcome ${verdict.driverOutcome} — retrying (${String(attempt)}/${String(retries)})`,
      );
      continue;
    }
    verdicts.push(verdict);
    break;
  }
}

// ---------- report ----------

const lines: string[] = [`# Agentic e2e run — ${stamp}`, ''];
let anyFail = false;
for (const v of verdicts) {
  lines.push(`## ${v.scenario} — driver: ${v.driverOutcome}`, '');
  lines.push('| criterion | verdict | evidence |', '|---|---|---|');
  for (const r of v.results) {
    if (!r.pass) anyFail = true;
    lines.push(`| ${r.label} | ${r.pass ? '✓' : '✗'} | ${r.evidence.replaceAll('|', '\\|')} |`);
  }
  if (v.driverOutcome !== 'done') anyFail = true;
  lines.push('', `driver reply: ${v.driverReply.slice(0, 500)}`, '');
}
writeFileSync(join(runDir, 'report.md'), lines.join('\n'));
console.log(`\n${lines.join('\n')}`);
console.log(`\nreport: ${join(runDir, 'report.md')}`);
process.exitCode = anyFail ? 1 : 0;
