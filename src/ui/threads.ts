/* Each assumption as a comment thread on its code.
 *
 * VS Code's comment threads are the popup this needs: they open between lines
 * and push the code down instead of covering it, they collapse to a gutter
 * icon, they edit in place, and every thread in the workspace is listed in the
 * Comments panel — which is Recall's side leaf, provided by the editor.
 *
 * One thread is one assumption, with at most two comments: the reader's
 * assumption, which they can edit as often as they like, and the answer to it.
 * There is no reply box once the assumption is written; rewriting it is how
 * the conversation moves, and each rewrite is checked afresh.
 *
 * A scratch note is drawn the same way with only the first comment: the
 * reader's text, shown as plain text rather than Markdown, and never answered.
 *
 * This file renders what the session holds and does nothing else. Every
 * action a thread offers is a command, handled in `extension.ts`.
 */
import * as vscode from 'vscode';

import { isFileScoped, kindOf, type Assumption, type EntryKind } from '../store/format';
import type { AssumptionSession } from '../session/session';
import { noteText, paintOf, statusOf, threadLabel, type Paint } from './present';

/** The reader's assumption, as the first comment of its thread. A class
 *  rather than a literal because the edit commands are handed this object
 *  back and need to know which assumption it is. */
export class ClaimComment implements vscode.Comment {
  readonly contextValue = 'claim';
  readonly author: vscode.CommentAuthorInformation;
  mode = vscode.CommentMode.Preview;
  body: string | vscode.MarkdownString;

  constructor(
    readonly uri: string,
    readonly id: string,
    readonly claim: string,
    readonly kind: EntryKind,
  ) {
    this.author = { name: kind === 'scratch' ? 'Note' : 'Assumption' };
    this.body = this.bodyOf(claim);
  }

  /** A scratch note is regular text: a plain string body is shown as typed,
   *  where Markdown would turn a stray `*` or `#` into formatting. */
  bodyOf(text: string): string | vscode.MarkdownString {
    return this.kind === 'scratch' ? text : new vscode.MarkdownString(text);
  }

  /** What the reader has typed, whichever form VS Code handed it back in. */
  get text(): string {
    return typeof this.body === 'string' ? this.body : this.body.value;
  }
}

interface Rendered {
  thread: vscode.CommentThread;
  claim: ClaimComment;
  /** Everything the comments are drawn from, so a redraw that would change
   *  nothing is skipped — reassigning `comments` resets the thread's view. */
  key: string;
}

export class Threads implements vscode.Disposable {
  private readonly rendered = new Map<string, Rendered>();
  private adoptee: vscode.CommentThread | null = null;

  constructor(
    private readonly controller: vscode.CommentController,
    private readonly session: AssumptionSession,
    private readonly icons: (paint: Paint) => vscode.Uri,
  ) {}

  /** The next assumption added to this thread's file takes over this thread
   *  rather than opening a new one — the draft the reader has just written
   *  into becomes the assumption, in place. */
  adoptNext(thread: vscode.CommentThread): void {
    this.adoptee = thread;
  }

  /** Which assumption a thread shows, for the commands on its title bar. */
  idFor(thread: vscode.CommentThread): string | null {
    for (const [id, r] of this.rendered) if (r.thread === thread) return id;
    return null;
  }

  threadFor(id: string): vscode.CommentThread | null {
    return this.rendered.get(id)?.thread ?? null;
  }

  /** Every thread showing an assumption on this file. */
  threadsFor(uri: string): vscode.CommentThread[] {
    return [...this.rendered.values()].filter((r) => r.claim.uri === uri).map((r) => r.thread);
  }

  /** Shows a claim comment in edit mode, or back in preview. */
  setEditing(comment: ClaimComment, editing: boolean): void {
    const r = this.rendered.get(comment.id);
    if (!r) return;
    comment.mode = editing ? vscode.CommentMode.Editing : vscode.CommentMode.Preview;
    if (!editing) comment.body = comment.bodyOf(comment.claim);
    r.thread.comments = [...r.thread.comments];
  }

  /** Brings the threads for one file into line with the session.
   *
   *  `doc` is needed to turn offsets into positions. Without it — the file is
   *  not open — threads keep the ranges they had and only their content is
   *  updated, and no new thread is opened for a span nobody can place. */
  sync(uri: string, doc: vscode.TextDocument | undefined): void {
    const assumptions = this.session.list(uri);
    const live = new Set(assumptions.map((a) => a.id));

    for (const [id, r] of this.rendered) {
      if (r.claim.uri === uri && !live.has(id)) {
        r.thread.dispose();
        this.rendered.delete(id);
      }
    }

    for (const a of assumptions) {
      const existing = this.rendered.get(a.id);
      const anchored = doc !== undefined && this.session.isAnchored(uri);
      if (!existing && !anchored) continue;
      const r = existing ?? this.create(uri, a, doc!);
      if (anchored) this.place(r.thread, a, doc!);
      this.render(r, a);
    }
  }

  private create(uri: string, a: Assumption, doc: vscode.TextDocument): Rendered {
    const adopted = this.adoptee !== null && this.adoptee.uri.toString() === uri ? this.adoptee : null;
    this.adoptee = null;

    // A thread must be created on a range; one whose code is gone is detached
    // from it straight away by `place`.
    const initial = this.rangeOf(a, doc) ?? new vscode.Range(0, 0, 0, 0);
    const thread = adopted ?? this.controller.createCommentThread(doc.uri, initial, []);
    thread.canReply = false;
    thread.collapsibleState = adopted
      ? vscode.CommentThreadCollapsibleState.Expanded
      : vscode.CommentThreadCollapsibleState.Collapsed;
    const r: Rendered = { thread, claim: new ClaimComment(uri, a.id, a.claim, kindOf(a)), key: '' };
    this.rendered.set(a.id, r);
    return r;
  }

  /** A note about the whole file sits at the top of it, where it is seen on
   *  opening the file; one whose code is gone has no place at all. */
  private rangeOf(a: Assumption, doc: vscode.TextDocument): vscode.Range | undefined {
    if (isFileScoped(a)) return new vscode.Range(0, 0, 0, 0);
    if (a.unanchored) return undefined;
    return new vscode.Range(doc.positionAt(a.from), doc.positionAt(a.to));
  }

  /** Moves a thread to where its code now is. A thread whose code is gone is
   *  attached to the file as a whole, where the Comments panel still lists
   *  it, rather than to wherever its old offsets happen to land. */
  private place(thread: vscode.CommentThread, a: Assumption, doc: vscode.TextDocument): void {
    const range = this.rangeOf(a, doc);
    const current = thread.range;
    if (range === undefined ? current === undefined : current?.isEqual(range)) return;
    thread.range = range;
  }

  private render(r: Rendered, a: Assumption): void {
    const running = this.session.isRunning(a.id);
    const status = statusOf(a, running);
    const note = noteText(a, running);

    r.thread.label = threadLabel(a, running);
    // `assumption`, `scratch`, and either with `-resolved`: what the title
    // bar's commands in package.json match on.
    r.thread.contextValue = `${kindOf(a)}${a.resolved ? '-resolved' : ''}`;
    r.thread.state = a.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;

    const key = JSON.stringify([a.claim, note, status, r.claim.mode]);
    if (key === r.key) return;
    r.key = key;

    // An assumption being edited keeps its comment object, or the reader's
    // half-typed rewrite would be thrown away by an unrelated redraw.
    if (r.claim.mode !== vscode.CommentMode.Editing && r.claim.claim !== a.claim) {
      r.claim = new ClaimComment(r.claim.uri, a.id, a.claim, kindOf(a));
    }

    const comments: vscode.Comment[] = [r.claim];
    if (note) {
      const answered = status.kind === 'verdict' || status.kind === 'checking';
      comments.push({
        author: {
          name: answered ? 'Claude' : 'Monolog',
          iconPath: this.icons(paintOf(status)),
        },
        body: new vscode.MarkdownString(note),
        mode: vscode.CommentMode.Preview,
        contextValue: 'answer',
      });
    }
    r.thread.comments = comments;
  }

  dispose(): void {
    for (const r of this.rendered.values()) r.thread.dispose();
    this.rendered.clear();
  }
}
