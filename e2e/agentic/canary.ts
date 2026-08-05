/**
 * Track C canary (test-hardening spec §Known risk): proves the ONE unproven
 * assumption — the MCP→customTools bridge — before the runner is built.
 * (pi-under-bun is already GO: scripts/pi-canary.ts, 2026-08-04.)
 *
 * Run: `bun e2e/agentic/canary.ts`  (needs ANTHROPIC_API_KEY or
 * OPENAI_API_KEY + CARTIS_MODEL/E2E_DRIVER_MODEL in the environment).
 *
 * Asserts, in order:
 *  1. chrome-devtools-mcp spawns and lists tools;
 *  2. an in-process pi driver session navigates a real page through them;
 *  3. the DIRECT harness channel (`browser.call('evaluate_script', …)`)
 *     verifies the page WITHOUT the agent;
 *  4. close() takes the MCP child (and its Chrome) down.
 */

import { connectBrowser } from './browser.ts';
import { runDriver } from './driver.ts';

function fail(message: string): never {
  console.error(`CANARY FAIL: ${message}`);
  process.exit(1);
}

const browser = await connectBrowser();
console.log(`connected — ${String(browser.tools.length)} MCP tools wrapped`);
if (browser.tools.length < 5) fail('too few tools listed');

try {
  // 2. the driver channel — a real pi session drives a navigation.
  const run = await runDriver(
    browser,
    'You drive a real browser through the provided tools. Be brief.',
    "Navigate to https://example.com and reply exactly 'DONE: ' followed by the page's h1 text.",
    3,
  );
  console.log(`driver outcome: ${run.outcome}; reply: ${run.reply.slice(0, 120)}`);
  if (!run.reply.includes('Example Domain')) fail('driver did not read the h1');

  // 3. the DIRECT verification channel — no agent involved.
  const result = await browser.call('evaluate_script', {
    function: '() => document.querySelector("h1")?.textContent ?? null',
  });
  const text = JSON.stringify(result);
  console.log(`direct evaluate_script → ${text.slice(0, 120)}`);
  if (!text.includes('Example Domain')) fail('direct channel did not read the h1');
} finally {
  await browser.close();
}

// 4. teardown proof: OUR child died (pid-scoped — never a machine-wide
// pgrep, which catches unrelated interactive MCP sessions).
await new Promise((r) => setTimeout(r, 1500));
if (browser.childPid !== undefined) {
  try {
    process.kill(browser.childPid, 0);
    fail(`chrome-devtools-mcp child ${String(browser.childPid)} survived close()`);
  } catch {
    // dead — good
  }
}

console.log('CANARY GO — MCP→customTools bridge + direct verification channel proven');
