/* What every file's assumptions are doing right now.
 *
 * The store knows what is on disk; the mapping and anchoring modules know
 * where a span is in a document; neither knows about the other. This is the
 * only thing that does. It loads a file's assumptions, puts each one back on
 * its code, follows the code through edits, records the answers to checks, and
 * writes the result back.
 *
 * Nothing here imports `vscode`. The editor reaches it through plain text and
 * change lists, and it reaches the editor only by raising `onChange`, so the
 * whole of it runs headless against strings with a map for a disk.
 *
 * Unlike Recall's Obsidian port there is one copy of a file's state, not one
 * per editor: VS Code has one `TextDocument` per file however many editors
 * show it, so there is nothing to broadcast.
 */
import { resolveAnchor } from '../anchor/anchoring';
import { mapSpanThrough, type TextChange } from '../anchor/mapping';
import type { Verdict } from '../checker/protocol';
import { isFileScoped, kindOf, type Assumption, type EntryKind } from '../store/format';
import type { EntryStore, LoadedRecord } from '../store/store';

/** Written rather than assigned, so `unanchored: false` never reaches disk. */
function withAnchorState(a: Assumption, unanchored: boolean): Assumption {
  const { unanchored: _drop, ...rest } = a;
  return unanchored ? { ...rest, unanchored: true } : rest;
}

/** Puts every assumption back on its code in `text`. Exported for the tests:
 *  this is the reopen path, where a file edited while nobody was watching
 *  either recovers or does not. A note about the whole file has no code to
 *  find, and is never lost. */
export function anchorAll(stored: readonly Assumption[], text: string): Assumption[] {
  return stored.map((a) => {
    if (isFileScoped(a)) return a;
    const found = resolveAnchor(text, a);
    if (found.kind === 'exact' || found.kind === 'quote') {
      return withAnchorState({ ...a, from: found.from, to: found.to, quote: text.slice(found.from, found.to) }, false);
    }
    return withAnchorState(a, true);
  });
}

function sameAnchoring(a: Assumption, b: Assumption): boolean {
  return a.from === b.from && a.to === b.to && a.quote === b.quote && !a.unanchored === !b.unanchored;
}

let counter = 0;
function defaultId(): string {
  // Unique across sessions without an index to keep in step, and short enough
  // to read in a record someone opens by hand.
  counter += 1;
  return `a${Date.now().toString(36)}${counter.toString(36)}`;
}

export class AssumptionSession {
  /** Every file's assumptions, keyed by URI then id. Insertion order is the
   *  order they were made. */
  private readonly files = new Map<string, Map<string, Assumption>>();
  /** Files whose assumptions have been anchored against an open document
   *  since they were loaded. Until then the stored offsets are a guess. */
  private readonly anchored = new Set<string>();
  /** The latest check asked for on each assumption. An answer carrying an
   *  older ticket is to a question nobody is asking any more. */
  private readonly tickets = new Map<string, number>();
  private nextTicket = 1;
  private readonly listeners = new Set<(uri: string) => void>();

  constructor(
    private readonly store: EntryStore,
    private readonly newId: () => string = defaultId,
  ) {}

  /** Returns its own unsubscribe. */
  onChange(listener: (uri: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(uri: string): void {
    for (const listener of this.listeners) listener(uri);
  }

  private save(uri: string): void {
    this.store.queue(uri, this.list(uri));
  }

  /** The files that have assumptions loaded. */
  uris(): string[] {
    return [...this.files.keys()];
  }

  list(uri: string): Assumption[] {
    return [...(this.files.get(uri)?.values() ?? [])];
  }

  get(uri: string, id: string): Assumption | null {
    return this.files.get(uri)?.get(id) ?? null;
  }

  isLoaded(uri: string): boolean {
    return this.files.has(uri);
  }

  isRunning(id: string): boolean {
    return this.tickets.has(id);
  }

  private update(uri: string, id: string, change: (a: Assumption) => Assumption): Assumption | null {
    const file = this.files.get(uri);
    const current = file?.get(id);
    if (!file || !current) return null;
    const next = change(current);
    file.set(id, next);
    this.save(uri);
    this.notify(uri);
    return next;
  }

  /** Takes what the store found at startup. Records for deleted files are left
   *  out; they come back through `open` if the file does. */
  loadRecords(records: readonly LoadedRecord[]): void {
    for (const record of records) {
      if (record.deleted || record.assumptions.length === 0) continue;
      this.files.set(record.uri, new Map(record.assumptions.map((a) => [a.id, a])));
      this.notify(record.uri);
    }
  }

  /** A document is open with this text. Puts its assumptions back on their
   *  code, loading them first if this is the first we have heard of the file.
   *
   *  Anchoring runs every time a file is opened, not only the first, because
   *  a file can change on disk while it is closed and its offsets are then
   *  nothing but a guess. It only writes when it actually moved something. */
  async open(uri: string, text: string): Promise<void> {
    if (!this.files.has(uri)) {
      const stored = await this.store.load(uri);
      if (stored.length === 0 || this.files.has(uri)) return;
      this.files.set(uri, new Map(stored.map((a) => [a.id, a])));
    }
    const file = this.files.get(uri)!;
    const before = [...file.values()];
    const after = anchorAll(before, text);
    for (const a of after) file.set(a.id, a);
    this.anchored.add(uri);

    if (after.some((a, i) => !sameAnchoring(a, before[i]!))) this.save(uri);
    this.notify(uri);
  }

  /** The document was closed. Its offsets stop being tracked, so the next
   *  `open` re-anchors rather than trusting them. */
  closed(uri: string): void {
    this.anchored.delete(uri);
  }

  isAnchored(uri: string): boolean {
    return this.anchored.has(uri);
  }

  /** The document changed. Every span follows its code; a span whose code was
   *  deleted is marked unanchored, and survives it.
   *
   *  Called on every keystroke, so it writes and notifies only when something
   *  it tracks actually moved. */
  edited(uri: string, changes: readonly TextChange[], text: string): void {
    const file = this.files.get(uri);
    if (!file || !this.anchored.has(uri)) return;

    let changed = false;
    for (const a of file.values()) {
      if (a.unanchored || isFileScoped(a)) continue;
      const span = mapSpanThrough(a, changes);
      const next =
        span === null
          ? withAnchorState(a, true)
          : { ...a, from: span.from, to: span.to, quote: text.slice(span.from, span.to) };
      if (sameAnchoring(a, next)) continue;
      file.set(a.id, next);
      changed = true;
    }
    if (!changed) return;
    this.save(uri);
    this.notify(uri);
  }

  /** Whether any assumption in the file has lost its code. */
  hasUnanchored(uri: string): boolean {
    return this.list(uri).some((a) => a.unanchored);
  }

  /** Tries every unanchored assumption against the document as it stands, and
   *  puts back each one whose quote now appears exactly once — an undo, or the
   *  same code pasted somewhere else. Returns how many went back. */
  reanchor(uri: string, text: string): number {
    const file = this.files.get(uri);
    if (!file || !this.anchored.has(uri)) return 0;

    let placed = 0;
    for (const a of file.values()) {
      if (!a.unanchored) continue;
      const found = resolveAnchor(text, a);
      if (found.kind !== 'exact' && found.kind !== 'quote') continue;
      const quote = text.slice(found.from, found.to);
      file.set(a.id, withAnchorState({ ...a, from: found.from, to: found.to, quote }, false));
      placed += 1;
    }
    if (placed > 0) {
      this.save(uri);
      this.notify(uri);
    }
    return placed;
  }

  /** Records a new assumption, or a scratch note. An assumption's check is
   *  asked for separately, so the thread exists — pending — from the moment it
   *  is written. A null span is the whole file, which only a note can be
   *  about. */
  add(
    uri: string,
    span: { from: number; to: number; quote: string } | null,
    claim: string,
    kind: EntryKind = 'assumption',
  ): Assumption {
    if (span === null && kind !== 'scratch') throw new Error('Only a note can be about a whole file.');
    let file = this.files.get(uri);
    if (!file) {
      // The span came from the live document, so a file with nothing else to
      // anchor is anchored by this. A file that had assumptions loaded went
      // through `open` first, which is the caller's job.
      file = new Map();
      this.files.set(uri, file);
      this.anchored.add(uri);
    }
    const assumption: Assumption = {
      id: this.newId(),
      ...(kind === 'scratch' ? { kind } : {}),
      ...(span === null ? { scope: 'file' as const } : {}),
      from: span?.from ?? 0,
      to: span?.to ?? 0,
      quote: span?.quote ?? '',
      claim,
      verdict: null,
      note: '',
      checkedQuote: null,
    };
    file.set(assumption.id, assumption);
    this.save(uri);
    this.notify(uri);
    return assumption;
  }

  /** The reader rewrote their assumption. The old verdict answered a question
   *  they are no longer asking, so it goes. */
  setClaim(uri: string, id: string, claim: string): Assumption | null {
    return this.update(uri, id, (a) => ({ ...a, claim, verdict: null, note: '', checkedQuote: null }));
  }

  /** A check is starting. Clears the previous answer, so the thread says it is
   *  checking rather than showing a verdict about to be replaced. A scratch
   *  note is never checked, and gets no ticket. */
  begin(uri: string, id: string): number | null {
    const a = this.get(uri, id);
    if (!a || kindOf(a) === 'scratch') return null;
    const ticket = this.nextTicket++;
    this.tickets.set(id, ticket);
    this.update(uri, id, (a) => ({ ...a, verdict: null, note: '', checkedQuote: null }));
    return ticket;
  }

  /** A check came back — or did not, in which case the verdict stays null on
   *  purpose. Ignored if a newer check has started since, or the assumption
   *  is gone. `checkedQuote` is the code that was sent. */
  finish(uri: string, id: string, ticket: number, verdict: Verdict | null, note: string, checkedQuote: string): void {
    if (this.tickets.get(id) !== ticket) return;
    this.tickets.delete(id);
    this.update(uri, id, (a) => ({ ...a, verdict, note, checkedQuote: verdict === null ? null : checkedQuote }));
  }

  /** Gives a scratch note a title, or takes it away when `title` is blank.
   *  An assumption has no title: what it says is the claim. */
  setTitle(uri: string, id: string, title: string): Assumption | null {
    const a = this.get(uri, id);
    if (!a || kindOf(a) !== 'scratch') return null;
    const clean = title.trim();
    return this.update(uri, id, (current) => {
      const { title: _drop, ...rest } = current;
      return clean ? { ...rest, title: clean } : rest;
    });
  }

  resolve(uri: string, id: string): void {
    this.update(uri, id, (a) => ({ ...a, resolved: true }));
  }

  reopen(uri: string, id: string): void {
    this.update(uri, id, (a) => {
      const { resolved: _drop, ...rest } = a;
      return rest;
    });
  }

  remove(uri: string, id: string): void {
    const file = this.files.get(uri);
    if (!file?.delete(id)) return;
    this.tickets.delete(id);
    this.save(uri);
    this.notify(uri);
  }

  /** A file's notes changed on disk, outside this session — a pull, a
   *  checkout, a hand edit of the metadata file. Its notes become `notes`;
   *  its assumptions are not the metadata file's, and are left alone. Nothing
   *  is saved: this is what was saved. `text` is the document, when it is
   *  open, to put the new notes on their code. */
  replaceNotes(uri: string, notes: readonly Assumption[], text: string | undefined): void {
    const kept = this.list(uri).filter((a) => kindOf(a) !== 'scratch');
    const placed = text !== undefined && this.anchored.has(uri) ? anchorAll(notes, text) : [...notes];
    const entries = [...kept, ...placed];
    if (entries.length === 0) {
      if (!this.files.delete(uri)) return;
    } else {
      this.files.set(uri, new Map(entries.map((a) => [a.id, a])));
    }
    this.notify(uri);
  }

  /** A file moved. The store moves the record; this moves the memory. */
  renamed(oldUri: string, newUri: string): void {
    const file = this.files.get(oldUri);
    if (!file) return;
    this.files.delete(oldUri);
    const existing = this.files.get(newUri);
    this.files.set(newUri, existing ? new Map([...existing, ...file]) : file);
    this.anchored.delete(oldUri);
    this.anchored.delete(newUri);
    this.notify(oldUri);
    this.notify(newUri);
  }

  /** Drops a file from memory without touching its record — the file was
   *  deleted, and the store has marked the record so. */
  forget(uri: string): void {
    const file = this.files.get(uri);
    if (!file) return;
    for (const id of file.keys()) this.tickets.delete(id);
    this.files.delete(uri);
    this.anchored.delete(uri);
    this.notify(uri);
  }
}
