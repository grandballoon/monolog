/* The assumptions for every file, one record at a time.
 *
 * The adapter is injected rather than imported, so everything here runs in a
 * test with a map for a disk. `extension.ts` supplies one over
 * `vscode.workspace.fs`, rooted in the extension's private storage for the
 * workspace — outside the repository, so nothing Monolog keeps can end up
 * in a commit.
 */
import { parseRecord, recordNameFor, serialiseRecord, FORMAT_VERSION } from './format';
import type { Assumption, FileRecord } from './format';

/** What the store needs from a disk. Paths are relative to the adapter's own
 *  root and use `/`. */
export interface StoreAdapter {
  /** The file's contents, or null if there is no such file. Throws only when
   *  the file exists and could not be read. */
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Names of the files directly inside a folder; empty if it does not exist. */
  list(folder: string): Promise<string[]>;
}

/** What the session needs from wherever its entries are kept. */
export interface EntryStore {
  /** A file's entries: what is queued for it, else what is saved. */
  load(uri: string): Promise<Assumption[]>;
  /** Saves a file's entries soon. */
  queue(uri: string, entries: Assumption[]): void;
}

export interface LoadedRecord {
  uri: string;
  deleted: boolean;
  assumptions: Assumption[];
}

export interface Unreadable {
  /** The source file's URI where the record said, else the record's name. */
  what: string;
  why: string;
}

const FOLDER = 'assumptions';
const SAVE_DELAY_MS = 1200;

export class AssumptionStore implements EntryStore {
  /** Records that could not be read this session, by source URI. Writing is
   *  off for each of them — Recall's safe mode, scoped to one file instead of
   *  the whole library. */
  private readonly unreadable = new Map<string, string>();
  private readonly pending = new Map<string, Assumption[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly adapter: StoreAdapter,
    private readonly delayMs: number = SAVE_DELAY_MS,
  ) {}

  private pathFor(uri: string): string {
    return `${FOLDER}/${recordNameFor(uri)}`;
  }

  /** The record for a file, a fresh one if nothing is saved, or null if what
   *  is saved could not be read. */
  private async readRecord(uri: string): Promise<FileRecord | null> {
    let raw: string | null;
    try {
      raw = await this.adapter.read(this.pathFor(uri));
    } catch (e) {
      this.unreadable.set(uri, `it could not be read (${(e as Error).message})`);
      return null;
    }

    const result = parseRecord(raw, uri);
    if (result.kind === 'unreadable') {
      this.unreadable.set(uri, result.why);
      return null;
    }
    this.unreadable.delete(uri);
    return result.kind === 'ok' ? result.record : { v: FORMAT_VERSION, uri, assumptions: [] };
  }

  /** Every record there is. The extension shows them all at startup, so the
   *  Comments panel lists every assumption in the workspace, not only those
   *  in files that happen to be open. */
  async loadAll(): Promise<{ records: LoadedRecord[]; unreadable: Unreadable[] }> {
    const records: LoadedRecord[] = [];
    const unreadable: Unreadable[] = [];
    for (const name of await this.adapter.list(FOLDER)) {
      if (!name.endsWith('.json')) continue;
      let raw: string | null;
      try {
        raw = await this.adapter.read(`${FOLDER}/${name}`);
      } catch (e) {
        unreadable.push({ what: name, why: `it could not be read (${(e as Error).message})` });
        continue;
      }
      const result = parseRecord(raw);
      if (result.kind === 'unreadable') {
        unreadable.push({ what: name, why: result.why });
        continue;
      }
      if (result.kind === 'empty') continue;
      // A record whose name is not its URI's hash would be invisible to every
      // later read and write, so it is not offered as loaded.
      if (recordNameFor(result.record.uri) !== name) {
        unreadable.push({ what: name, why: `it is filed under the wrong name for ${result.record.uri}` });
        continue;
      }
      records.push({
        uri: result.record.uri,
        deleted: result.record.deleted === true,
        assumptions: result.record.assumptions,
      });
    }
    for (const entry of unreadable) this.unreadable.set(entry.what, entry.why);
    return { records, unreadable };
  }

  /** The assumptions for one file, or none. A record that is unreadable reads
   *  as none and refuses to be written — never as a fresh start. */
  async load(uri: string): Promise<Assumption[]> {
    const queued = this.pending.get(uri);
    if (queued) return queued;
    return (await this.readRecord(uri))?.assumptions ?? [];
  }

  /** Why a file's assumptions could not be read, or null if they could. */
  whyUnreadable(uri: string): string | null {
    return this.unreadable.get(uri) ?? null;
  }

  /** Writes now. Refuses on a record we failed to read, because carrying on
   *  with an empty set would save that emptiness over whatever is there. */
  async save(uri: string, assumptions: Assumption[]): Promise<void> {
    const existing = await this.readRecord(uri);
    if (existing === null) return;

    const path = this.pathFor(uri);
    if (assumptions.length === 0 && !existing.deleted) {
      await this.adapter.remove(path);
      return;
    }
    await this.adapter.write(
      path,
      serialiseRecord({
        v: FORMAT_VERSION,
        uri,
        ...(existing.deleted ? { deleted: true as const } : {}),
        assumptions,
      }),
    );
  }

  /** Debounced: a write per keystroke is a write per keystroke however small
   *  the record is. */
  queue(uri: string, assumptions: Assumption[]): void {
    this.pending.set(uri, assumptions);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
    // A pending write never holds a process open on its own; the extension
    // flushes on deactivate, which is the one exit that matters.
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const queued = [...this.pending];
    this.pending.clear();
    for (const [uri, assumptions] of queued) await this.save(uri, assumptions);
  }

  /** A file moved. The record's name is a function of the URI, so the record
   *  moves with it and says where it now belongs.
   *
   *  A record we cannot parse still moves — as the bytes we found, untouched.
   *  Leaving it behind would strand it under a URI no file has any more, and
   *  rewriting it would be exactly the overwrite this store refuses. If the
   *  destination already has assumptions of its own, the two are merged
   *  rather than one being written over the other. */
  async handleRename(oldUri: string, newUri: string): Promise<void> {
    await this.flush();
    const from = this.pathFor(oldUri);

    let raw: string | null;
    try {
      raw = await this.adapter.read(from);
    } catch (e) {
      this.unreadable.set(oldUri, `it could not be read (${(e as Error).message})`);
      return;
    }
    const parsed = parseRecord(raw, oldUri);
    if (parsed.kind === 'empty') return;

    let body: string;
    if (parsed.kind === 'ok') {
      const destination = await this.readRecord(newUri);
      if (destination === null) return; // Unreadable where it would land: leave both be.
      body = serialiseRecord({
        v: FORMAT_VERSION,
        uri: newUri,
        assumptions: [...destination.assumptions, ...parsed.record.assumptions],
      });
    } else {
      body = raw!;
    }

    await this.adapter.write(this.pathFor(newUri), body);
    await this.adapter.remove(from);

    const why = this.unreadable.get(oldUri);
    if (why !== undefined) {
      this.unreadable.delete(oldUri);
      this.unreadable.set(newUri, why);
    }
  }

  /** A file was deleted. Its assumptions are kept and marked. */
  async handleDelete(uri: string): Promise<void> {
    await this.flush();
    const record = await this.readRecord(uri);
    if (record === null || record.assumptions.length === 0) return;
    await this.adapter.write(this.pathFor(uri), serialiseRecord({ ...record, deleted: true }));
  }

  /** A file appeared at a URI whose assumptions we had marked deleted — it was
   *  restored, or checked out again. The flag comes off as soon as we hear. */
  async handleCreate(uri: string): Promise<boolean> {
    const record = await this.readRecord(uri);
    if (record === null || record.deleted !== true) return false;
    const { deleted: _gone, ...revived } = record;
    await this.adapter.write(this.pathFor(uri), serialiseRecord(revived));
    return true;
  }

  /** The command behind "prune assumptions for deleted files". Only records
   *  that say their file is gone, and only on being asked.
   *
   *  `exists` says whether a file is there right now. The flag alone is not
   *  evidence — a file that came back wears a stale one, and pruning on the
   *  flag by itself would destroy the assumptions of a file sitting right
   *  there. Those are repaired instead, which is what makes this safe to run
   *  at any time. */
  async prune(exists: (uri: string) => Promise<boolean>): Promise<string[]> {
    await this.flush();
    const pruned: string[] = [];
    for (const name of await this.adapter.list(FOLDER)) {
      const path = `${FOLDER}/${name}`;
      let raw: string | null;
      try {
        raw = await this.adapter.read(path);
      } catch {
        continue; // Unreadable stays put; we do not delete what we cannot read.
      }
      const parsed = parseRecord(raw);
      if (parsed.kind !== 'ok' || parsed.record.deleted !== true) continue;

      if (await exists(parsed.record.uri)) {
        const { deleted: _gone, ...revived } = parsed.record;
        await this.adapter.write(path, serialiseRecord(revived));
        continue;
      }
      await this.adapter.remove(path);
      pruned.push(parsed.record.uri);
    }
    return pruned;
  }
}
