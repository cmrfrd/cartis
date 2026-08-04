/**
 * Session-entry mapping + tree anchors (migration spec §4.1/§4.2).
 *
 * `mapSessionEntries`: the ACTIVE branch (root→leaf) → ThreadMessages. All
 * non-message entry types are skipped except `turn_meta` custom entries,
 * which resolve attachment names for their turn. One turn's assistant
 * entries (text + toolCall rounds) merge into ONE ThreadMessage whose id is
 * the LAST assistant entry id — exactly the `assistantEntryId` the turn
 * response reports, so client re-keying and rehydration agree.
 *
 * `computeAnchors`: ‹ n/m › data from the REAL tree — user-message siblings
 * under a common parent; switching targets each sibling's deepest
 * most-recent descendant. `switchBranch` makes the selection DURABLE via a
 * `leaf_switch` custom entry (pi's leaf pointer is in-memory; reopen picks
 * the last file entry — whose root-path is then the selected branch).
 */

import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { MessageId } from '../../contracts/ids.ts';
import type { ThreadMessageT, ThreadPartT } from '../../contracts/thread.ts';

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
}
interface Entry {
  id: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  data?: {
    userEntryId?: string;
    attachments?: Array<{ name: string; mime: string }>;
    contextImages?: number;
    leafId?: string;
  };
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    stopReason?: string;
  };
}

const blocksOf = (content: string | ContentBlock[] | undefined): ContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);

/** Strip inlined `<file name="…">…</file>` blocks from a stored user text. */
const strippedUserText = (text: string): string => {
  const at = text.indexOf('\n\n<file name="');
  return (at >= 0 ? text.slice(0, at) : text).trim();
};

export function mapSessionEntries(sessionManager: SessionManager): ThreadMessageT[] {
  const branch = sessionManager.getBranch() as unknown as Entry[];
  // turn_meta by userEntryId (attachment names for rehydrated bubbles).
  const metaByUser = new Map<string, NonNullable<Entry['data']>>();
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === 'turn_meta' && entry.data?.userEntryId) {
      metaByUser.set(entry.data.userEntryId, entry.data);
    }
  }

  const out: ThreadMessageT[] = [];
  // Pending assistant-turn accumulation (merged across toolUse rounds).
  let acc: { parts: ThreadPartT[]; lastId: string; incomplete: boolean } | undefined;
  const callIndex = new Map<string, number>(); // toolCallId → part index
  const flush = () => {
    if (acc === undefined) return;
    out.push({
      id: MessageId.make(acc.lastId),
      role: 'assistant',
      status: acc.incomplete ? 'incomplete' : 'complete',
      parts: acc.parts,
    });
    acc = undefined;
    callIndex.clear();
  };

  for (const entry of branch) {
    if (entry.type !== 'message') continue; // skip custom/model_change/… types
    const role = entry.message?.role;
    if (role === 'user') {
      flush();
      const blocks = blocksOf(entry.message?.content);
      const text = strippedUserText(
        blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join(''),
      );
      const meta = metaByUser.get(entry.id);
      const parts: ThreadPartT[] = [];
      // Persisted user images: first N are the author's attachments (per
      // turn_meta); the context tail (preview/art) is skipped.
      const images = blocks.filter((b) => b.type === 'image');
      const userImages = meta
        ? (meta.attachments ?? []).filter((a) => a.mime.startsWith('image/'))
        : [];
      images.slice(0, userImages.length).forEach((img) => {
        parts.push({
          _tag: 'Image',
          url: `data:${img.mimeType ?? 'image/png'};base64,${img.data ?? ''}`,
        });
      });
      for (const a of meta?.attachments ?? []) {
        if (!a.mime.startsWith('image/')) parts.push({ _tag: 'File', name: a.name, mime: a.mime });
      }
      parts.push({ _tag: 'Text', text });
      out.push({ id: MessageId.make(entry.id), role: 'user', status: 'complete', parts });
      continue;
    }
    if (role === 'assistant') {
      const blocks = blocksOf(entry.message?.content);
      acc ??= { parts: [], lastId: entry.id, incomplete: false };
      acc.lastId = entry.id;
      if (entry.message?.stopReason === 'aborted' || entry.message?.stopReason === 'error') {
        acc.incomplete = true;
      }
      for (const block of blocks) {
        if (block.type === 'text' && (block.text ?? '').trim().length > 0) {
          acc.parts.push({ _tag: 'Text', text: (block.text ?? '').trim() });
        } else if (block.type === 'toolCall') {
          callIndex.set(block.id ?? '', acc.parts.length);
          acc.parts.push({
            _tag: 'ToolCall',
            callId: block.id ?? 'call',
            name: block.name ?? 'tool',
            status: 'running',
            argsText: JSON.stringify(block.arguments ?? {}),
          });
        }
      }
      continue;
    }
    if (role === 'toolResult') {
      const at = callIndex.get(entry.message?.toolCallId ?? '');
      if (acc !== undefined && at !== undefined) {
        const part = acc.parts[at];
        if (part !== undefined && part._tag === 'ToolCall') {
          const text = blocksOf(entry.message?.content)
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');
          acc.parts[at] = {
            ...part,
            status: entry.message?.isError === true ? 'error' : 'completed',
            ...(text.length > 0 ? { result: text } : {}),
            ...(entry.message?.isError === true ? { isError: true } : {}),
          };
        }
      }
    }
  }
  flush();
  return out;
}

export interface TreeAnchor {
  messageId: string; // the CURRENT branch's user entry at this fork
  index: number; // 1-based among siblings
  count: number;
  siblingLeafIds: string[]; // branch() targets, sibling order
}

interface TreeNode {
  entry: Entry;
  children: TreeNode[];
}

const isUserNode = (n: TreeNode): boolean =>
  n.entry.type === 'message' && n.entry.message?.role === 'user';

/** Deepest most-recent descendant — the branch's live tip (file order = recency). */
const tipOf = (node: TreeNode): string => {
  let current = node;
  while (current.children.length > 0) {
    current = current.children[current.children.length - 1] as TreeNode;
  }
  return current.entry.id;
};

export function computeAnchors(sessionManager: SessionManager): TreeAnchor[] {
  const tree = sessionManager.getTree() as unknown as TreeNode[];
  const activeIds = new Set((sessionManager.getBranch() as unknown as Entry[]).map((e) => e.id));
  const anchors: TreeAnchor[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      const userChildren = node.children.filter(isUserNode);
      if (userChildren.length > 1) {
        const activeChild = userChildren.find((c) => activeIds.has(c.entry.id));
        if (activeChild !== undefined) {
          anchors.push({
            messageId: activeChild.entry.id,
            index: userChildren.indexOf(activeChild) + 1,
            count: userChildren.length,
            siblingLeafIds: userChildren.map(tipOf),
          });
        }
      }
      walk(node.children);
    }
  };
  walk(tree);
  // Root-level user siblings (multiple roots) — same rule at the top level.
  const rootUsers = tree.filter(isUserNode);
  if (rootUsers.length > 1) {
    const active = rootUsers.find((c) => activeIds.has(c.entry.id));
    if (active !== undefined) {
      anchors.unshift({
        messageId: active.entry.id,
        index: rootUsers.indexOf(active) + 1,
        count: rootUsers.length,
        siblingLeafIds: rootUsers.map(tipOf),
      });
    }
  }
  return anchors;
}

/** Durable branch switch (spec §4.1 blocker-1 rule). */
export function switchBranch(sessionManager: SessionManager, leafId: string): void {
  sessionManager.branch(leafId);
  sessionManager.appendCustomEntry('leaf_switch', { leafId });
}
