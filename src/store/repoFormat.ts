/* The repository's metadata file: every note on every file in one workspace
 * folder, in one file, kept with the code.
 *
 * Where `format.ts` is Monolog's private record, this is a published one. It
 * is meant to be committed, read by people in review, and read by tools that
 * know nothing of Monolog. So it is shaped for them rather than for the
 * session: paths are relative to the folder and use `/`, a note says whether
 * it is about a span or the whole file by having a `span` or not, its tags
 * are written out beside its text, and nothing that only this machine knows —
 * whether a span is currently found, what a check said — is in it.
 *
 * It is written sorted, one way only, so the same notes always produce the
 * same bytes and a diff shows only what changed.
 *
 *   {
 *     "version": 1,
 *     "tags": { "perf": { "color": "red" } },
 *     "notes": [
 *       {
 *         "path": "src/total.ts",
 *         "id": "…",
 *         "span": { "from": 52, "to": 81, "quote": "xs.reduce(…)" },
 *         "title": "Fold",
 *         "tags": ["perf"],
 *         "text": "#perf allocates on every call",
 *         "resolved": true
 *       }
 *     ]
 *   }
 *
 * Fields this build does not know are ignored on reading and not written
 * back. Anything else that is not as above makes the whole file unreadable,
 * and an unreadable file is never written over.
 */
import { tagsOf } from '../tags/tags';
import { isFileScoped, kindOf, type Assumption } from './format';

/** Where the file lives, relative to the workspace folder. */
export const REPO_FILE = '.monolog/metadata.json';
export const REPO_VERSION = 1;

/** What the repository says about a tag. `color` is kept as written, so a
 *  colour this build does not know survives a round trip; it is checked
 *  against the palette where it is used. */
export interface TagDefinition {
  color?: string;
}

export interface RepoDocument {
  tags: Map<string, TagDefinition>;
  /** Notes by path, each path's in the order they are written. */
  notes: Map<string, Assumption[]>;
}

export type RepoReadResult =
  | { kind: 'ok'; doc: RepoDocument }
  /** No file yet: the only failure that may lead to writing. */
  | { kind: 'empty' }
  | { kind: 'unreadable'; why: string };

interface DiskSpan {
  from: number;
  to: number;
  quote: string;
}

interface DiskNote {
  path: string;
  id: string;
  span?: DiskSpan;
  title?: string;
  tags: string[];
  text: string;
  resolved?: true;
}

export function emptyRepoDocument(): RepoDocument {
  return { tags: new Map(), notes: new Map() };
}

/** Notes about the whole file first, then by where their span starts. */
function byPlace(a: Assumption, b: Assumption): number {
  const fa = isFileScoped(a) ? -1 : a.from;
  const fb = isFileScoped(b) ? -1 : b.from;
  return fa - fb || a.to - b.to || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function toDisk(path: string, a: Assumption): DiskNote {
  return {
    path,
    id: a.id,
    ...(isFileScoped(a) ? {} : { span: { from: a.from, to: a.to, quote: a.quote } }),
    ...(a.title ? { title: a.title } : {}),
    tags: tagsOf(a.claim),
    text: a.claim,
    ...(a.resolved ? { resolved: true as const } : {}),
  };
}

function fromDisk(n: DiskNote): Assumption {
  return {
    id: n.id,
    kind: 'scratch',
    ...(n.span
      ? { from: n.span.from, to: n.span.to, quote: n.span.quote }
      : { scope: 'file' as const, from: 0, to: 0, quote: '' }),
    claim: n.text,
    verdict: null,
    note: '',
    checkedQuote: null,
    ...(n.title ? { title: n.title } : {}),
    ...(n.resolved ? { resolved: true as const } : {}),
  };
}

/** One path's notes in the form they are written, as a string: equal
 *  strings mean equal notes on disk. Everything the file does not carry —
 *  whether a span is currently found — is left out, so it never counts as a
 *  change. */
export function notesKey(path: string, notes: readonly Assumption[]): string {
  return JSON.stringify([...notes].sort(byPlace).map((a) => toDisk(path, a)));
}

export function tagsKey(tags: ReadonlyMap<string, TagDefinition>): string {
  return JSON.stringify([...tags].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function serialiseRepoDocument(doc: RepoDocument): string {
  const tags: Record<string, TagDefinition> = {};
  for (const [name, def] of [...doc.tags].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    tags[name] = def.color === undefined ? {} : { color: def.color };
  }
  const notes = [...doc.notes]
    .filter(([, list]) => list.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([path, list]) => [...list].sort(byPlace).map((a) => toDisk(path, a)));
  return `${JSON.stringify({ version: REPO_VERSION, tags, notes }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Relative, with `/`, and inside the folder: a path that climbs out of it
 *  would have Monolog open files the repository has no business naming. */
function isRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.includes('\\')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function isOffset(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function readNote(value: unknown): DiskNote | string {
  if (!isRecord(value)) return 'a note is not an object';
  const { path, id, span, title, text, resolved } = value;
  if (!isRelativePath(path)) return `a note's path, ${JSON.stringify(path)}, is not a relative path inside the folder`;
  if (typeof id !== 'string' || id === '') return `a note on ${path} has no id`;
  if (typeof text !== 'string') return `note ${id} has no text`;
  if (title !== undefined && typeof title !== 'string') return `note ${id} has a title that is not text`;
  if (resolved !== undefined && resolved !== true) return `note ${id} has a "resolved" that is not true`;
  if (span !== undefined) {
    if (!isRecord(span) || !isOffset(span.from) || !isOffset(span.to) || typeof span.quote !== 'string') {
      return `note ${id} has a span that is not {from, to, quote}`;
    }
    if (span.to < span.from) return `note ${id} has a span that ends before it starts`;
  }
  return {
    path,
    id,
    ...(span !== undefined ? { span: span as unknown as DiskSpan } : {}),
    ...(title ? { title } : {}),
    tags: [],
    text,
    ...(resolved ? { resolved } : {}),
  };
}

/** Says why a read failed rather than returning a bare nothing, as
 *  `parseRecord` does: "no file yet" may lead to writing, and "something is
 *  wrong here" — a merge conflict left in it, say — must not. */
export function parseRepoDocument(raw: string | null): RepoReadResult {
  if (raw === null || raw.trim() === '') return { kind: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: 'unreadable', why: `it is not valid JSON (${(e as Error).message})` };
  }
  if (!isRecord(parsed)) return { kind: 'unreadable', why: 'it is not shaped like a Monolog metadata file' };
  if (parsed.version !== REPO_VERSION) {
    return {
      kind: 'unreadable',
      why: `it is format version ${String(parsed.version)}, and this build reads ${REPO_VERSION}`,
    };
  }

  const tags = new Map<string, TagDefinition>();
  const rawTags = parsed.tags ?? {};
  if (!isRecord(rawTags)) return { kind: 'unreadable', why: '"tags" is not an object' };
  for (const [name, def] of Object.entries(rawTags)) {
    if (!isRecord(def) || (def.color !== undefined && typeof def.color !== 'string')) {
      return { kind: 'unreadable', why: `tag ${name} is not shaped like {"color": "…"}` };
    }
    tags.set(name, def.color === undefined ? {} : { color: def.color });
  }

  const rawNotes = parsed.notes ?? [];
  if (!Array.isArray(rawNotes)) return { kind: 'unreadable', why: '"notes" is not a list' };
  const notes = new Map<string, Assumption[]>();
  const ids = new Set<string>();
  for (const value of rawNotes) {
    const note = readNote(value);
    if (typeof note === 'string') return { kind: 'unreadable', why: note };
    const key = `${note.path}\n${note.id}`;
    if (ids.has(key)) return { kind: 'unreadable', why: `note ${note.id} appears twice on ${note.path}` };
    ids.add(key);
    const list = notes.get(note.path) ?? [];
    list.push(fromDisk(note));
    notes.set(note.path, list);
  }

  return { kind: 'ok', doc: { tags, notes } };
}

/** Whether an entry belongs in this file: notes do, assumptions do not. */
export function isRepoEntry(a: Assumption): boolean {
  return kindOf(a) === 'scratch';
}
