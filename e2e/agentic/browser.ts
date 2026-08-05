/**
 * The harness-owned browser connection (test-hardening spec §Track C).
 *
 * CANARY STATUS (2026-08-04): **GO** — `bun e2e/agentic/canary.ts` under bun:
 * 29 tools wrapped, a real pi driver session (openai/gpt-5.2) navigated
 * example.com through them and replied `DONE: Example Domain`, the direct
 * `call('evaluate_script', …)` channel verified the h1 WITHOUT the agent,
 * and close() took the child down (pid-scoped check). Re-run on
 * chrome-devtools-mcp or @modelcontextprotocol/sdk bumps.
 *
 * One `@modelcontextprotocol/sdk` stdio client to a spawned
 * `chrome-devtools-mcp` process (which launches Chrome). The SAME client
 * serves two channels:
 *   - `tools`: every MCP tool wrapped as a pi custom tool (the DRIVER acts
 *     through these);
 *   - `call()`: direct invocation (the HARNESS verifies through this — page
 *     criteria and screenshots never relay through the agent).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/* biome-ignore-start lint/suspicious/noExplicitAny: pi's ToolDefinition generics need a loose slot */
type AnyTool = any;
/* biome-ignore-end lint/suspicious/noExplicitAny: pi's ToolDefinition generics */

export interface Browser {
  /** Call any chrome-devtools tool directly (the verification channel). */
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** pi customTools wrapping every MCP tool (the driver channel). */
  tools: AnyTool[];
  /** The spawned chrome-devtools-mcp child pid (teardown checks THIS pid —
   * never a machine-wide pgrep, which would catch unrelated MCP sessions). */
  childPid: number | undefined;
  close(): Promise<void>;
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** MCP tool result content → pi tool-result content (text + images). */
function toPiContent(blocks: McpContentBlock[]): Array<Record<string, unknown>> {
  return blocks.map((b) =>
    b.type === 'image'
      ? { type: 'image', data: b.data ?? '', mimeType: b.mimeType ?? 'image/png' }
      : { type: 'text', text: b.text ?? '' },
  );
}

export async function connectBrowser(): Promise<Browser> {
  const transport = new StdioClientTransport({
    command: 'bunx',
    // --allow-unrestricted-paths: without it upload_file/take_screenshot are
    // fenced to "workspace roots" we never negotiate — staged fixtures under
    // the repo were Access-denied (live-caught: the photo-card driver burned
    // its whole budget on it). This browser is harness-owned and isolated.
    args: ['chrome-devtools-mcp@latest', '--isolated', '--allow-unrestricted-paths'],
  });
  const client = new Client({ name: 'cartis-e2e-harness', version: '1.0.0' });
  await client.connect(transport);

  const listed = await client.listTools();
  const tools: AnyTool[] = listed.tools.map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description ?? t.name,
    parameters: t.inputSchema,
    executionMode: 'sequential',
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = await client.callTool({ name: t.name, arguments: params });
      const content = toPiContent((result.content ?? []) as McpContentBlock[]);
      return {
        content: content.length > 0 ? content : [{ type: 'text', text: 'ok' }],
        isError: result.isError === true,
        details: {},
      };
    },
  }));

  const childPid = transport.pid ?? undefined;

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  return {
    tools,
    childPid,
    call: async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args });
      return result.content;
    },
    close: async () => {
      await client.close();
      // The stdio close SHOULD end the child; enforce it (and give the
      // process group a moment to fold before the survivor check).
      if (childPid !== undefined && alive(childPid)) {
        try {
          process.kill(childPid, 'SIGTERM');
        } catch {
          // already gone
        }
        await new Promise((r) => setTimeout(r, 1000));
        if (alive(childPid)) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    },
  };
}
