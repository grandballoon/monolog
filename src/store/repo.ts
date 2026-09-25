/* One workspace folder's metadata file, held in memory and kept in step with
 * the disk.
 *
 * Unlike the private store, this file has other writers: a pull, a checkout,
 * a teammate's merge, a person with an editor. So every read and every write
 * is a three-way merge, one path at a time, against the file as it was last
 * read or written:
 *
 *  - a path the disk did not change keeps what the session holds, written
 *    or not;
 *  - a path the disk changed takes the disk's notes, and any unwritten
 *    change of ours to that path is dropped. The file wins, so a checkout
 *    shows the checked-out notes rather than the ones from before it.
 *
 * Tags merge the same way, as one unit. What the disk changed is returned,
 * so the session can be told.
 *
 * The rule from the private store holds: a file that cannot be read is never
 * written over. While it is unreadable, what is held here stays held, and
 * `StoreRouter` keeps the notes that change meanwhile in private storage.
 */
import { tagsOf } from '../tags/tags';
import type { Assumption } from './format';
import {
  REPO_FILE,
  emptyRepoDocument,
  notesKey,
  parseRepoDocument,
  serialiseRepoDocument,
  tagsKey,
  type TagDefinition,
} from './repoFormat';
import type { StoreAdapter } from './store';

export interface RepoSync {
  /** Paths whose notes the disk changed to something other than what was
   *  held here. */
  paths: string[];
  tagsChanged: boolean;
  /** Why the file cannot be read, when this read is the one that found out. */
  unreadable: string | null;
  /** This read found readable a file that was not. */
  recovered: boolean;
}

const NOTHING: RepoSync = { paths: [], tagsChanged: false, unreadable: null, recovered: false };

export class RepoStore {
  private notes = new Map<string, Assumption[]>();
  private tags = new Map<string, TagDefinition>();
  /** Each path's notes, and the tags, as the disk last had them. */
  private base = new Map<string, string>();
  private baseTags = tagsKey(new Map());
  /** Paths changed here and not yet written, with the generation of the
   *  change, so a change made while a write is in flight is not marked
   *  written by it. */
  private readonly dirty = new Map<string, number>();
  private tagsDirty = 0;
  private generation = 0;
  /** The bytes last read or written. `undefined` until the first read. */
  private seen: string | null | undefined = undefined;
  private why: string | null = null;
  /** Reads and writes run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly adapter: StoreAdapter) {}

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  hasRead(): boolean {
    return this.seen !== undefined;
  }

  whyUnreadable(): string | null {
    return this.why;
  }

  isDirty(): boolean {
    return this.dirty.size > 0 || this.tagsDirty > 0;
  }

  dirtyPaths(): string[] {
    return [...this.dirty.keys()];
  }

  /** Paths with notes. */
  paths(): string[] {
    return [...this.notes].filter(([, list]) => list.length > 0).map(([path]) => path);
  }

  notesAt(path: string): Assumption[] {
    return [...(this.notes.get(path) ?? [])];
  }

  setNotes(path: string, notes: readonly Assumption[]): void {
    if (notes.length === 0) this.notes.delete(path);
    else this.notes.set(path, [...notes]);
    this.dirty.set(path, ++this.generation);
  }

  /** Forgets an unwritten change to `path`, once it is safe somewhere else. */
  release(path: string): void {
    this.dirty.delete(path);
  }

  tagDefinitions(): ReadonlyMap<string, TagDefinition> {
    return this.tags;
  }

  /** Every tag the folder knows: those with a definition, and those its notes
   *  use. */
  knownTags(): string[] {
    const all = new Set(this.tags.keys());
    for (const list of this.notes.values()) for (const a of list) for (const t of tagsOf(a.claim)) all.add(t);
    return [...all].sort();
  }

  /** Sets or clears a tag's colour. A tag left with no definition is removed
   *  from the file; it is still a tag wherever a note uses it. */
  setTagColor(tag: string, color: string | null): void {
    const { color: _old, ...rest } = this.tags.get(tag) ?? {};
    const next: TagDefinition = color === null ? rest : { ...rest, color };
    if (Object.keys(next).length === 0) this.tags.delete(tag);
    else this.tags.set(tag, next);
    this.tagsDirty = ++this.generation;
  }

  /** Reads the file once, if it has never been read. */
  async ensureRead(): Promise<void> {
    if (this.seen === undefined) await this.sync();
  }

  /** Takes in whatever the disk changed since it was last read or written. */
  sync(): Promise<RepoSync> {
    return this.exclusive(() => this.syncNow());
  }

  /** Writes what changed here, after taking in what changed on disk. Does
   *  nothing to a file it cannot read. */
  write(): Promise<RepoSync> {
    return this.exclusive(async () => {
      const result = await this.syncNow();
      if (this.why === null && this.isDirty()) await this.writeNow();
      return result;
    });
  }

  private unreadable(why: string): RepoSync {
    const news = this.why !== why;
    this.why = why;
    return news ? { ...NOTHING, unreadable: why } : NOTHING;
  }

  private async syncNow(): Promise<RepoSync> {
    let raw: string | null;
    try {
      raw = await this.adapter.read(REPO_FILE);
    } catch (e) {
      return this.unreadable(`it could not be read (${(e as Error).message})`);
    }
    if (raw === this.seen && this.why === null) return NOTHING;
    this.seen = raw;

    const parsed = parseRepoDocument(raw);
    if (parsed.kind === 'unreadable') return this.unreadable(parsed.why);
    const recovered = this.why !== null;
    this.why = null;
    const disk = parsed.kind === 'ok' ? parsed.doc : emptyRepoDocument();

    const paths: string[] = [];
    for (const path of new Set([...this.base.keys(), ...disk.notes.keys()])) {
      const theirs = disk.notes.get(path) ?? [];
      const key = notesKey(path, theirs);
      if (key === (this.base.get(path) ?? notesKey(path, []))) continue;
      if (key !== notesKey(path, this.notes.get(path) ?? [])) paths.push(path);
      if (theirs.length === 0) this.notes.delete(path);
      else this.notes.set(path, theirs);
      this.dirty.delete(path);
      this.rebase(path, key);
    }

    let tagsChanged = false;
    const theirTags = tagsKey(disk.tags);
    if (theirTags !== this.baseTags) {
      tagsChanged = theirTags !== tagsKey(this.tags);
      this.tags = disk.tags;
      this.tagsDirty = 0;
      this.baseTags = theirTags;
    }

    return { paths, tagsChanged, unreadable: null, recovered };
  }

  private rebase(path: string, key: string): void {
    if (key === notesKey(path, [])) this.base.delete(path);
    else this.base.set(path, key);
  }

  private async writeNow(): Promise<void> {
    const upTo = this.generation;
    const empty = this.paths().length === 0 && this.tags.size === 0;
    const written = new Map([...this.dirty.keys()].map((path) => [path, notesKey(path, this.notes.get(path) ?? [])]));
    const writtenTags = tagsKey(this.tags);

    // Nothing to keep, and no file to keep it in: a folder whose notes were
    // all deleted before they were ever written gets no file at all.
    if (!(empty && this.seen === null)) {
      const out = serialiseRepoDocument({ tags: this.tags, notes: this.notes });
      await this.adapter.write(REPO_FILE, out);
      this.seen = out;
    }

    for (const [path, key] of written) {
      this.rebase(path, key);
      if ((this.dirty.get(path) ?? Infinity) <= upTo) this.dirty.delete(path);
    }
    this.baseTags = writtenTags;
    if (this.tagsDirty <= upTo) this.tagsDirty = 0;
  }
}
