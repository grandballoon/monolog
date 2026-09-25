/* Where each entry is kept.
 *
 * Notes are the repository's: they go to the metadata file of the workspace
 * folder the file is in (`repo.ts`), to be committed with the code and read
 * by anyone. Assumptions are the reader's: they, and Claude's answers to
 * them, stay in the private store (`store.ts`), outside the workspace. A
 * note on a file outside every workspace folder has no repository, and stays
 * private too.
 *
 * The session sees one store. This is it: it splits each file's entries on
 * the way out and joins them on the way in.
 *
 * Notes can also be held privately for a file inside a folder: notes written
 * before the metadata file existed, and notes changed while that folder's
 * file could not be read. Those are newer than anything the metadata file
 * has, so they win over it on loading, and they are moved into it as soon as
 * it can be written — at startup, and whenever an unreadable file is fixed.
 *
 * Nothing here imports `vscode`. Which folder a file is in, and what its path
 * is there, is asked of an injected `RepoLocator`.
 */
import { tagsOf, isTagColor, type TagColor } from '../tags/tags';
import type { Assumption } from './format';
import { RepoStore, type RepoSync } from './repo';
import { REPO_FILE, isRepoEntry } from './repoFormat';
import type { AssumptionStore, EntryStore, LoadedRecord, Unreadable } from './store';

export interface RepoLocator {
  /** The workspace folder a file is in, and its path inside it with `/`, or
   *  null for a file in none. Both are strings, as URIs are elsewhere. */
  locate(uri: string): { root: string; path: string } | null;
  uriOf(root: string, path: string): string;
}

/** Something about a folder's metadata file changed outside this session. */
export interface RepoChange {
  root: string;
  /** Files whose notes are now different. */
  uris: string[];
  tagsChanged: boolean;
  /** Why the file cannot be read, the first time that is found. */
  unreadable: string | null;
}

const SAVE_DELAY_MS = 1200;

export class StoreRouter implements EntryStore {
  private readonly repos = new Map<string, RepoStore>();
  private readonly listeners = new Set<(change: RepoChange) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly personal: AssumptionStore,
    private readonly locator: RepoLocator,
    private readonly openRepo: (root: string) => RepoStore,
    private readonly delayMs: number = SAVE_DELAY_MS,
  ) {}

  /** Returns its own unsubscribe. */
  onRepoChange(listener: (change: RepoChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private repo(root: string): RepoStore {
    let repo = this.repos.get(root);
    if (!repo) {
      repo = this.openRepo(root);
      this.repos.set(root, repo);
    }
    return repo;
  }

  /** The folder's store if its file can be read, having read it if needed. */
  private async readable(root: string): Promise<RepoStore | null> {
    const repo = this.repo(root);
    await repo.ensureRead();
    return repo.whyUnreadable() === null ? repo : null;
  }

  // ------------------------------------------------------------------
  // What the session calls.
  // ------------------------------------------------------------------

  async load(uri: string): Promise<Assumption[]> {
    const personal = await this.personal.load(uri);
    const at = this.locator.locate(uri);
    const repo = at && (await this.readable(at.root));
    if (!at || !repo) return personal;
    const held = new Set(personal.map((a) => a.id));
    return [...personal, ...repo.notesAt(at.path).filter((n) => !held.has(n.id))];
  }

  queue(uri: string, entries: Assumption[]): void {
    const at = this.locator.locate(uri);
    const repo = at ? this.repo(at.root) : null;
    if (!at || !repo || !repo.hasRead() || repo.whyUnreadable() !== null) {
      this.personal.queue(uri, entries);
      return;
    }
    repo.setNotes(at.path, entries.filter(isRepoEntry));
    this.personal.queue(uri, entries.filter((a) => !isRepoEntry(a)));
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.personal.flush();
    for (const root of this.repos.keys()) await this.writeRepo(root);
  }

  private async writeRepo(root: string): Promise<void> {
    const repo = this.repo(root);
    const result = await repo.write();
    // Refused: the file cannot be read. What was waiting to be written goes
    // to private storage rather than being held only in memory.
    if (repo.whyUnreadable() !== null) {
      for (const path of repo.dirtyPaths()) {
        const uri = this.locator.uriOf(root, path);
        const notes = repo.notesAt(path);
        const ids = new Set(notes.map((a) => a.id));
        const kept = (await this.personal.load(uri)).filter((a) => !ids.has(a.id));
        await this.personal.save(uri, [...kept, ...notes]);
        repo.release(path);
      }
    }
    await this.after(root, result);
  }

  // ------------------------------------------------------------------
  // The disk changing under us.
  // ------------------------------------------------------------------

  /** The folder's metadata file changed on disk, or may have. */
  async syncRepo(root: string): Promise<void> {
    await this.after(root, await this.repo(root).sync());
  }

  private async after(root: string, result: RepoSync): Promise<void> {
    if (result.recovered) {
      await this.personal.flush();
      await this.migrate((await this.personal.loadAll()).records);
      if (this.repo(root).isDirty()) this.schedule();
    }
    if (result.paths.length === 0 && !result.tagsChanged && result.unreadable === null) return;
    const change: RepoChange = {
      root,
      uris: result.paths.map((path) => this.locator.uriOf(root, path)),
      tagsChanged: result.tagsChanged,
      unreadable: result.unreadable,
    };
    for (const listener of this.listeners) listener(change);
  }

  // ------------------------------------------------------------------
  // Startup, and moving notes out of private storage.
  // ------------------------------------------------------------------

  /** Every file's entries, from both stores. `roots` are the workspace
   *  folders, whose metadata files are read whether or not any note in them
   *  has been seen yet. */
  async loadAll(roots: readonly string[]): Promise<{ records: LoadedRecord[]; unreadable: Unreadable[] }> {
    const { records, unreadable } = await this.personal.loadAll();
    for (const root of roots) {
      const repo = this.repo(root);
      await repo.ensureRead();
      const why = repo.whyUnreadable();
      if (why !== null) unreadable.push({ what: `${root}/${REPO_FILE}`, why });
    }

    const merged = new Map((await this.migrate(records)).map((r) => [r.uri, { ...r }]));
    for (const [root, repo] of this.repos) {
      if (repo.whyUnreadable() !== null) continue;
      for (const path of repo.paths()) {
        const uri = this.locator.uriOf(root, path);
        const record = merged.get(uri);
        if (!record) {
          merged.set(uri, { uri, deleted: false, assumptions: repo.notesAt(path) });
          continue;
        }
        const held = new Set(record.assumptions.map((a) => a.id));
        record.assumptions = [...record.assumptions, ...repo.notesAt(path).filter((n) => !held.has(n.id))];
      }
    }
    return { records: [...merged.values()], unreadable };
  }

  /** Moves notes held privately into their folder's metadata file, where it
   *  can be read. They leave private storage only once they are written
   *  there. Returns the records as they are after the move. */
  private async migrate(records: readonly LoadedRecord[]): Promise<LoadedRecord[]> {
    const moved: { root: string; path: string; record: LoadedRecord }[] = [];
    const out: LoadedRecord[] = [];
    for (const record of records) {
      const at = this.locator.locate(record.uri);
      const held = record.assumptions.filter(isRepoEntry);
      const repo = at && held.length > 0 ? await this.readable(at.root) : null;
      if (!at || !repo) {
        out.push(record);
        continue;
      }
      const ids = new Set(held.map((a) => a.id));
      repo.setNotes(at.path, [...repo.notesAt(at.path).filter((n) => !ids.has(n.id)), ...held]);
      moved.push({ ...at, record });
    }

    for (const root of new Set(moved.map((m) => m.root))) await this.repo(root).write();
    for (const { root, path, record } of moved) {
      const repo = this.repo(root);
      const safe = repo.whyUnreadable() === null && !repo.dirtyPaths().includes(path);
      const rest = safe ? record.assumptions.filter((a) => !isRepoEntry(a)) : record.assumptions;
      if (safe) await this.personal.save(record.uri, rest);
      out.push({ ...record, assumptions: rest });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Files moving.
  // ------------------------------------------------------------------

  /** A file moved. Its assumptions move in private storage; its notes move
   *  within, or between, metadata files — written where they arrive before
   *  they are removed from where they left. */
  async handleRename(oldUri: string, newUri: string): Promise<void> {
    await this.flush();
    await this.personal.handleRename(oldUri, newUri);

    const from = this.locator.locate(oldUri);
    const source = from && (await this.readable(from.root));
    if (!from || !source) return;
    const moving = source.notesAt(from.path);
    if (moving.length === 0) return;

    const to = this.locator.locate(newUri);
    const target = to && (await this.readable(to.root));
    if (to && target) {
      target.setNotes(to.path, [...target.notesAt(to.path), ...moving]);
      if (to.root !== from.root) await this.writeRepo(to.root);
    } else {
      await this.personal.save(newUri, [...(await this.personal.load(newUri)), ...moving]);
    }
    source.setNotes(from.path, []);
    await this.writeRepo(from.root);
  }

  /** A file was deleted. Its notes stay in the metadata file, as its
   *  assumptions stay in private storage, until the prune command. */
  async handleDelete(uri: string): Promise<void> {
    await this.personal.handleDelete(uri);
  }

  /** A file appeared. Whether it has entries to show. */
  async handleCreate(uri: string): Promise<boolean> {
    if (await this.personal.handleCreate(uri)) return true;
    const at = this.locator.locate(uri);
    const repo = at && (await this.readable(at.root));
    return !!at && !!repo && repo.notesAt(at.path).length > 0;
  }

  /** Removes the entries of files that are not there. Returns their URIs. */
  async prune(exists: (uri: string) => Promise<boolean>): Promise<string[]> {
    const pruned = await this.personal.prune(exists);
    for (const [root, repo] of this.repos) {
      if (repo.whyUnreadable() !== null) continue;
      let changed = false;
      for (const path of repo.paths()) {
        const uri = this.locator.uriOf(root, path);
        if (await exists(uri)) continue;
        repo.setNotes(path, []);
        pruned.push(uri);
        changed = true;
      }
      if (changed) await this.writeRepo(root);
    }
    return [...new Set(pruned)];
  }

  // ------------------------------------------------------------------
  // Tags.
  // ------------------------------------------------------------------

  /** The colour of each tag that has one, for a file's folder. A colour the
   *  palette does not have is no colour. */
  tagColors(uri: string): Map<string, TagColor> {
    const at = this.locator.locate(uri);
    const colors = new Map<string, TagColor>();
    if (!at) return colors;
    for (const [tag, def] of this.repo(at.root).tagDefinitions()) {
      if (isTagColor(def.color)) colors.set(tag, def.color);
    }
    return colors;
  }

  /** Every tag known in a file's folder, or used in the file itself. */
  knownTags(uri: string, entries: readonly Assumption[] = []): string[] {
    const at = this.locator.locate(uri);
    const all = new Set(at ? this.repo(at.root).knownTags() : []);
    for (const a of entries) if (isRepoEntry(a)) for (const t of tagsOf(a.claim)) all.add(t);
    return [...all].sort();
  }

  /** Sets a tag's colour for a file's folder, and writes it. Returns why it
   *  could not, or null. */
  async setTagColor(uri: string, tag: string, color: TagColor | null): Promise<string | null> {
    const at = this.locator.locate(uri);
    if (!at) return 'this file is not in a workspace folder, so there is no metadata file to keep the colour in';
    const repo = await this.readable(at.root);
    if (!repo) return `${REPO_FILE} cannot be read: ${this.repo(at.root).whyUnreadable()}`;
    repo.setTagColor(tag, color);
    await this.writeRepo(at.root);
    const why = repo.whyUnreadable();
    return why === null ? null : `${REPO_FILE} cannot be read: ${why}`;
  }
}
