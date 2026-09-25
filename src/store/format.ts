/* What a file's assumptions look like on disk, and how to read them back.
 *
 * One record per source file rather than one for the workspace, as in
 * Recall's Obsidian port: a write touches one file's assumptions, a bad record
 * costs one file's assumptions, and nothing rewrites a workspace-sized blob on
 * every keystroke.
 *
 * The rule Recall arrived at the hard way is kept: a record that cannot be
 * read is never written over. `parseRecord` says *why* it failed, so the
 * caller can tell "nothing saved yet" from "something is wrong here", because
 * carrying on with an empty set over the second one is silent and total.
 */
import { normaliseQuote } from '../anchor/anchoring';
import { VERDICTS, type Verdict } from '../checker/protocol';

export const FORMAT_VERSION = 1;

/** What an entry is. An assumption is checked against its code. A scratch
 *  note is the reader's scratchpad: plain text kept on the code the same way,
 *  never checked and never sent anywhere. Absent on disk means an assumption,
 *  so records written before scratch notes existed read unchanged. */
export type EntryKind = 'assumption' | 'scratch';

export interface Assumption {
  id: string;
  /** Written only for a scratch note. Read it through `kindOf`. */
  kind?: 'scratch';
  /** Written only for a note about the file as a whole rather than a span of
   *  it. Only a scratch note can be one; its `from`, `to` and `quote` are
   *  empty and nothing anchors it. Read it through `isFileScoped`. */
  scope?: 'file';
  /** Offsets into the file as it was when this was last written. Edits keep
   *  them current while the file is open; `quote` puts the assumption back
   *  when it was not. */
  from: number;
  to: number;
  /** The code the span covers, as last seen. */
  quote: string;
  /** What the reader assumes about that code, or the text of a scratch note.
   *  Theirs, and never rewritten by anything but them. */
  claim: string;
  /** Null when no assessment exists — in flight, failed, demo mode, or a
   *  scratch note, which is never assessed. The code is never labelled by a
   *  check that did not happen. */
  verdict: Verdict | null;
  /** Claude's note on a verdict, or what went wrong when there is none. Empty
   *  while the check is in flight, which is how an interrupted one is known. */
  note: string;
  /** The code the verdict was given against. When `quote` stops matching it,
   *  the verdict is stale: it answered a question about code that is gone. */
  checkedQuote: string | null;
  /** True once an edit deleted the span. The assumption survives it, and goes
   *  back as soon as its quote appears exactly once again. */
  unanchored?: true;
  /** The reader has dealt with it. The record stays; the highlight comes off. */
  resolved?: true;
  /** A scratch note's title, shown as its heading and on hover. Absent when
   *  it has none; never written on an assumption. */
  title?: string;
}

export interface FileRecord {
  v: number;
  /** The file these belong to, as a URI string. Carried in the record so a
   *  filename collision is detectable rather than silently serving another
   *  file's assumptions. */
  uri: string;
  /** Set when the source file was deleted. A delete is reversible — through
   *  the trash, an undo, a checkout — and deleting the reader's writing with it
   *  is not. */
  deleted?: true;
  assumptions: Assumption[];
}

export type ReadResult =
  | { kind: 'ok'; record: FileRecord }
  /** Nothing saved yet — the only failure that may lead to writing. */
  | { kind: 'empty' }
  | { kind: 'unreadable'; why: string };

export function kindOf(a: Assumption): EntryKind {
  return a.kind === 'scratch' ? 'scratch' : 'assumption';
}

/** Whether this is about the whole file rather than a span of it. */
export function isFileScoped(a: Assumption): boolean {
  return a.scope === 'file';
}

/** Whether the verdict answered a question about code that has since changed.
 *  Whitespace is ignored, so reformatting does not throw a check away. */
export function isStale(a: Assumption): boolean {
  return (
    a.verdict !== null &&
    a.checkedQuote !== null &&
    normaliseQuote(a.checkedQuote) !== normaliseQuote(a.quote)
  );
}

/** Asked for and never answered — VS Code closed, or the extension reloaded,
 *  while the check was in flight. No completed outcome leaves the note empty:
 *  a demo card and a failed check both write one. A scratch note is never
 *  asked for, so it is never unfinished. */
export function isUnfinished(a: Assumption): boolean {
  return kindOf(a) === 'assumption' && a.verdict === null && a.note === '';
}

/** FNV-1a, 64-bit. A file's URI decides its record's name with no index to
 *  keep in step, and 64 bits makes a collision a non-event — which the `uri`
 *  check inside the record catches anyway. */
export function recordNameFor(uri: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const ch of uri) {
    hash = (hash ^ BigInt(ch.codePointAt(0)!)) & MASK;
    hash = (hash * PRIME) & MASK;
  }
  return `${hash.toString(16).padStart(16, '0')}.json`;
}

export function serialiseRecord(record: FileRecord): string {
  return JSON.stringify(record, null, 1);
}

function isAssumption(value: unknown): value is Assumption {
  const a = value as Assumption;
  return (
    !!a &&
    typeof a === 'object' &&
    typeof a.id === 'string' &&
    (a.kind === undefined || a.kind === 'scratch') &&
    (a.scope === undefined || (a.scope === 'file' && a.kind === 'scratch')) &&
    (a.title === undefined || typeof a.title === 'string') &&
    typeof a.from === 'number' &&
    typeof a.to === 'number' &&
    typeof a.quote === 'string' &&
    typeof a.claim === 'string' &&
    typeof a.note === 'string' &&
    (a.verdict === null || (VERDICTS as readonly unknown[]).includes(a.verdict)) &&
    (a.checkedQuote === null || typeof a.checkedQuote === 'string')
  );
}

/** Reports why a read failed rather than returning a bare nothing.
 *
 *  `expectedUri` is checked against the record's own when given: two files
 *  hashing to one name would otherwise hand a file somebody else's
 *  assumptions. Listing every record passes none. */
export function parseRecord(raw: string | null, expectedUri?: string): ReadResult {
  if (raw === null || raw.trim() === '') return { kind: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: 'unreadable', why: `it is not valid JSON (${(e as Error).message})` };
  }

  const record = parsed as Partial<FileRecord>;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { kind: 'unreadable', why: 'it is not shaped like a Monolog record' };
  }
  if (record.v !== FORMAT_VERSION) {
    return {
      kind: 'unreadable',
      why: `it is format version ${String(record.v)}, and this build reads ${FORMAT_VERSION}`,
    };
  }
  if (typeof record.uri !== 'string') {
    return { kind: 'unreadable', why: 'it does not say which file it belongs to' };
  }
  if (expectedUri !== undefined && record.uri !== expectedUri) {
    return { kind: 'unreadable', why: `it belongs to ${record.uri}, not ${expectedUri}` };
  }
  if (!Array.isArray(record.assumptions) || !record.assumptions.every(isAssumption)) {
    return { kind: 'unreadable', why: 'its assumptions are not shaped like assumptions' };
  }

  return {
    kind: 'ok',
    record: {
      v: FORMAT_VERSION,
      uri: record.uri,
      ...(record.deleted === true ? { deleted: true as const } : {}),
      assumptions: record.assumptions,
    },
  };
}
