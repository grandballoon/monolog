/* The extension entry point — the only file that knows every other part.
 *
 * The session holds the assumptions and notes and knows nothing of VS Code.
 * The router persists them — notes to each workspace folder's metadata file,
 * assumptions to private storage — through adapters it is handed. `Threads`,
 * `Decorations` and `FileNotes` draw what the session holds. The checker
 * sends one assumption to Claude.
 * This file listens to VS Code — documents opening, changing, closing and
 * moving — tells the session, and turns each command into a call on the parts
 * that do the work.
 */
import * as vscode from 'vscode';

import { assess, verifyKey } from './checker';
import { demoOutcome, failureOutcome } from './check/outcome';
import { AssumptionSession } from './session/session';
import { normaliseSettings, type Settings } from './settings/settings';
import { kindOf, type EntryKind } from './store/format';
import { RepoStore } from './store/repo';
import { REPO_FILE, isRepoEntry } from './store/repoFormat';
import { StoreRouter, type RepoChange, type RepoLocator } from './store/router';
import { AssumptionStore } from './store/store';
import { TAG_COLORS, type TagColor } from './tags/tags';
import { workspaceAdapter } from './ui/adapter';
import { Decorations } from './ui/decorations';
import { FileNotes } from './ui/explorer';
import { tagColorOf, tagPaint, type Paint } from './ui/present';
import { tagCompletions } from './ui/tagCompletion';
import { ClaimComment, Threads } from './ui/threads';

const SECRET_KEY = 'monolog.anthropicApiKey';
/** Whether notes are painted in their tags' colours: remembered per
 *  workspace, and mirrored in a context key of the same name for the editor
 *  title's toggle. */
const TAG_COLORS_SHOWN = 'monolog.tagColors';
/** Whether the active editor's file has a note with a coloured tag, which is
 *  when the toggle is worth a place in its title bar. */
const FILE_HAS_TAG_COLORS = 'monolog.fileHasTagColors';
/** How long after an edit to look for lost code coming back. Long enough not
 *  to search the file on every keystroke, short enough that an undo visibly
 *  brings its assumption back. */
const REANCHOR_DELAY_MS = 400;

/** What the end-to-end suite reaches for. Not an API anyone else should use. */
export interface MonologTestApi {
  ready: Promise<void>;
  /** Where the records are kept, so the suite can read what reached disk. */
  storage: vscode.Uri;
  session: AssumptionSession;
  router: StoreRouter;
  threads: Threads;
  fileNotes: FileNotes;
  /** The colours notes are painted with in a file right now, or null while
   *  tag colours are hidden. */
  tagColors(uri: string): ReadonlyMap<string, TagColor> | null;
  /** For opening a thread with no context value, as the gutter's + does. */
  controller: vscode.CommentController;
  flush(): Promise<void>;
  check(uri: string, id: string): Promise<void>;
}

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('monolog');
  return normaliseSettings({
    model: config.get('model'),
    effort: config.get('effort'),
    demoMode: config.get('demoMode'),
    inlineSummary: config.get('inlineSummary'),
  });
}

function keyOf(uri: vscode.Uri): string {
  return uri.toString();
}

/** Only files on disk: an untitled buffer or a git diff view has nowhere for
 *  an assumption to live that would still be there tomorrow. The metadata
 *  file itself is left out: a note on it would be written into it, moving
 *  itself as it was written. */
function isTracked(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && !doc.uri.path.endsWith(`/${REPO_FILE}`);
}

/** Workspace folders as repositories: a file's metadata lives in the folder
 *  it is in, under its path from there. */
const locator: RepoLocator = {
  locate(uri) {
    const parsed = vscode.Uri.parse(uri);
    if (parsed.scheme !== 'file') return null;
    const folder = vscode.workspace.getWorkspaceFolder(parsed);
    if (!folder) return null;
    const prefix = `${folder.uri.path.replace(/\/$/, '')}/`;
    if (!parsed.path.startsWith(prefix)) return null;
    return { root: keyOf(folder.uri), path: parsed.path.slice(prefix.length) };
  },
  uriOf(root, path) {
    return keyOf(vscode.Uri.joinPath(vscode.Uri.parse(root), ...path.split('/')));
  },
};

function openDocument(uri: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => keyOf(d.uri) === uri);
}

/** The span a draft thread was opened on, as offsets. A thread opened from the
 *  gutter covers whole lines; either way, surrounding whitespace is trimmed
 *  so the span is the code and not the indentation around it. */
function spanOf(doc: vscode.TextDocument, range: vscode.Range): { from: number; to: number; quote: string } | null {
  const lines = range.isEmpty || (range.start.character === 0 && range.end.character === 0);
  const whole = lines
    ? new vscode.Range(range.start.line, 0, range.end.line, doc.lineAt(range.end.line).range.end.character)
    : range;
  const text = doc.getText(whole);
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  if (lead === text.length) return null;
  const from = doc.offsetAt(whole.start) + lead;
  const to = doc.offsetAt(whole.end) - trail;
  return { from, to, quote: text.slice(lead, text.length - trail) };
}

export function activate(context: vscode.ExtensionContext): MonologTestApi {
  const root = context.storageUri ?? context.globalStorageUri;
  const router = new StoreRouter(
    new AssumptionStore(workspaceAdapter(root)),
    locator,
    (folder) => new RepoStore(workspaceAdapter(vscode.Uri.parse(folder))),
  );
  const session = new AssumptionSession(router);
  flushOnExit = () => router.flush();
  let settings = readSettings();
  let tagColorsShown = context.workspaceState.get<boolean>(TAG_COLORS_SHOWN, true);
  void vscode.commands.executeCommand('setContext', TAG_COLORS_SHOWN, tagColorsShown);
  const tagColors = (uri: string): ReadonlyMap<string, TagColor> | null =>
    tagColorsShown ? router.tagColors(uri) : null;

  const controller = vscode.comments.createCommentController('monolog', 'Monolog');
  controller.options = {
    prompt: 'Write down an assumption about this code, or a note…',
    placeHolder: 'An assumption is checked against the code; a note is kept as you write it',
  };
  controller.commentingRangeProvider = {
    provideCommentingRanges(doc) {
      return isTracked(doc) ? [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)] : [];
    },
  };

  const icon = (paint: Paint) => vscode.Uri.joinPath(context.extensionUri, 'media', `verdict-${paint}.svg`);
  const threads = new Threads(controller, session, icon);
  const decorations = new Decorations((name) => vscode.Uri.joinPath(context.extensionUri, 'media', name));
  const fileNotes = new FileNotes((uri) => session.list(uri), tagColors);
  context.subscriptions.push(controller, threads, decorations, fileNotes);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileNotes));

  /** Sets the context key that shows the tag colour toggle in the active
   *  editor's title bar. */
  const updateTitleBar = (): void => {
    const doc = vscode.window.activeTextEditor?.document;
    const uri = doc && isTracked(doc) ? keyOf(doc.uri) : null;
    const colors = uri ? router.tagColors(uri) : null;
    const has = !!uri && !!colors && session.list(uri).some((a) => tagColorOf(a, colors) !== null);
    void vscode.commands.executeCommand('setContext', FILE_HAS_TAG_COLORS, has);
  };

  const redraw = (uri: string): void => {
    threads.sync(uri, openDocument(uri));
    decorations.draw(uri, session.list(uri), (id) => session.isRunning(id), settings.inlineSummary, tagColors(uri));
    fileNotes.refresh(uri);
    if (vscode.window.activeTextEditor && keyOf(vscode.window.activeTextEditor.document.uri) === uri) {
      updateTitleBar();
    }
  };
  const unsubscribe = session.onChange(redraw);
  context.subscriptions.push({ dispose: unsubscribe });

  const redrawVisible = (): void => {
    const shown = new Set(vscode.window.visibleTextEditors.map((e) => keyOf(e.document.uri)));
    for (const uri of shown) redraw(uri);
  };

  /** Tag colours changed, or were switched on or off: every file may look
   *  different. */
  const redrawTags = (): void => {
    redrawVisible();
    fileNotes.refresh();
    updateTitleBar();
  };

  const opened = (doc: vscode.TextDocument): Promise<void> =>
    isTracked(doc) ? session.open(keyOf(doc.uri), doc.getText()) : Promise.resolve();

  // ------------------------------------------------------------------
  // Startup: every assumption in the workspace, not only open files'.
  // ------------------------------------------------------------------

  const ready = (async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    folders.forEach(watchFolder);
    const { records, unreadable } = await router.loadAll(folders.map((f) => keyOf(f.uri)));
    session.loadRecords(records);
    for (const record of records) {
      if (record.deleted) continue;
      try {
        // Opening a document here shows nothing; it gives the session the
        // text to anchor against, and the threads a place to go.
        await opened(await vscode.workspace.openTextDocument(vscode.Uri.parse(record.uri)));
      } catch {
        // The file is gone without anyone telling us. Its assumptions stay
        // in memory and on disk; the prune command is for them.
      }
    }
    await Promise.all(vscode.workspace.textDocuments.map(opened));
    if (unreadable.length > 0) {
      void vscode.window.showWarningMessage(
        `Monolog could not read ${unreadable.length} saved record${unreadable.length === 1 ? '' : 's'} ` +
          `and will not write over ${unreadable.length === 1 ? 'it' : 'them'}: ${unreadable[0]!.why}.`,
      );
    }
    updateTitleBar();
  })();

  // ------------------------------------------------------------------
  // The metadata files: each folder's is watched, because a pull, a
  // checkout or a hand edit changes it under us.
  // ------------------------------------------------------------------

  function watchFolder(folder: vscode.WorkspaceFolder): void {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, REPO_FILE));
    const sync = (): void => void router.syncRepo(keyOf(folder.uri));
    context.subscriptions.push(watcher, watcher.onDidChange(sync), watcher.onDidCreate(sync), watcher.onDidDelete(sync));
  }

  const repoChanged = async (change: RepoChange): Promise<void> => {
    if (change.unreadable !== null) {
      void vscode.window.showWarningMessage(
        `Monolog cannot read ${vscode.workspace.asRelativePath(vscode.Uri.joinPath(vscode.Uri.parse(change.root), REPO_FILE))} ` +
          `and will not write over it: ${change.unreadable}. Notes changed meanwhile are kept privately until it can be read.`,
      );
    }
    for (const uri of change.uris) {
      const notes = (await router.load(uri)).filter(isRepoEntry);
      let doc = openDocument(uri);
      session.replaceNotes(uri, notes, doc?.getText());
      if (doc || notes.length === 0) continue;
      try {
        // As at startup: every note is listed in the Comments panel, which
        // needs its document open.
        doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        await opened(doc);
      } catch {
        // No such file here. Its notes wait in memory and in the file.
      }
    }
    if (change.tagsChanged) redrawTags();
  };
  const stopRepoChanges = router.onRepoChange((change) => void repoChanged(change));
  context.subscriptions.push({ dispose: stopRepoChanges });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.added) {
        watchFolder(folder);
        void router.syncRepo(keyOf(folder.uri));
      }
    }),
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'comment' },
      tagCompletions(() => {
        const doc = vscode.window.activeTextEditor?.document;
        const uri = doc && isTracked(doc) ? keyOf(doc.uri) : null;
        if (uri) return router.knownTags(uri, session.list(uri));
        const folders = vscode.workspace.workspaceFolders ?? [];
        return [...new Set(folders.flatMap((f) => router.knownTags(keyOf(f.uri))))].sort();
      }),
      '#',
    ),
  );

  // ------------------------------------------------------------------
  // Following the code.
  // ------------------------------------------------------------------

  const reanchorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleReanchor = (doc: vscode.TextDocument): void => {
    const uri = keyOf(doc.uri);
    clearTimeout(reanchorTimers.get(uri));
    reanchorTimers.set(
      uri,
      setTimeout(() => {
        reanchorTimers.delete(uri);
        if (!doc.isClosed) session.reanchor(uri, doc.getText());
      }, REANCHOR_DELAY_MS),
    );
  };
  context.subscriptions.push({ dispose: () => reanchorTimers.forEach(clearTimeout) });

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => void opened(doc)),
    vscode.workspace.onDidCloseTextDocument((doc) => session.closed(keyOf(doc.uri))),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const uri = keyOf(event.document.uri);
      if (event.contentChanges.length === 0 || !session.isLoaded(uri)) return;
      session.edited(
        uri,
        event.contentChanges.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })),
        event.document.getText(),
      );
      if (session.hasUnanchored(uri)) scheduleReanchor(event.document);
    }),
    vscode.window.onDidChangeVisibleTextEditors(redrawVisible),
    vscode.window.onDidChangeActiveTextEditor(updateTitleBar),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('monolog')) return;
      settings = readSettings();
      redrawVisible();
    }),
  );

  // ------------------------------------------------------------------
  // Following the files. A folder event names only the folder, so every
  // file under it is found by prefix.
  // ------------------------------------------------------------------

  const affected = (uri: vscode.Uri): string[] => {
    const key = keyOf(uri);
    return session.uris().filter((u) => u === key || u.startsWith(`${key}/`));
  };

  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (event) => {
      for (const { oldUri, newUri } of event.files) {
        for (const from of affected(oldUri)) {
          const to = keyOf(newUri) + from.slice(keyOf(oldUri).length);
          await router.handleRename(from, to);
          session.renamed(from, to);
          const doc = openDocument(to);
          if (doc) await session.open(to, doc.getText());
        }
      }
    }),
    vscode.workspace.onDidDeleteFiles(async (event) => {
      for (const uri of event.files) {
        for (const gone of affected(uri)) {
          await router.handleDelete(gone);
          session.forget(gone);
        }
      }
    }),
    vscode.workspace.onDidCreateFiles(async (event) => {
      for (const uri of event.files) {
        if (!(await router.handleCreate(keyOf(uri)))) continue;
        try {
          await opened(await vscode.workspace.openTextDocument(uri));
        } catch {
          // A folder, or not a text file; nothing to show.
        }
      }
    }),
  );

  // ------------------------------------------------------------------
  // Checking.
  // ------------------------------------------------------------------

  let toldAboutKey = false;

  const check = async (uri: string, id: string): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    if (!session.isAnchored(uri)) await session.open(uri, doc.getText());
    const before = session.get(uri, id);
    // A scratch note is never checked, whatever asked.
    if (!before || kindOf(before) === 'scratch') return;
    if (before.unanchored) {
      void vscode.window.showInformationMessage(
        'The code this assumption was about is gone, so there is nothing to check it against. ' +
          'It will be checkable again if the code comes back.',
      );
      return;
    }

    const ticket = session.begin(uri, id);
    if (ticket === null) return;
    const text = doc.getText();
    const quote = text.slice(before.from, before.to);

    if (settings.demoMode) {
      const outcome = demoOutcome('chosen');
      session.finish(uri, id, ticket, outcome.verdict, outcome.note, quote);
      return;
    }

    const apiKey = await context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      const outcome = demoOutcome('no-key');
      session.finish(uri, id, ticket, outcome.verdict, outcome.note, quote);
      if (!toldAboutKey) {
        toldAboutKey = true;
        const choice = await vscode.window.showInformationMessage(
          'Monolog saved your assumption, but has no Anthropic API key to check it with.',
          'Set API Key',
        );
        if (choice) await vscode.commands.executeCommand('monolog.setApiKey');
      }
      return;
    }

    try {
      const assessment = await assess(
        apiKey,
        {
          path: vscode.workspace.asRelativePath(doc.uri),
          languageId: doc.languageId,
          text,
          from: before.from,
          to: before.to,
          claim: before.claim,
        },
        { model: settings.model, effort: settings.effort },
      );
      session.finish(uri, id, ticket, assessment.verdict, assessment.note, quote);
    } catch (e) {
      const outcome = failureOutcome(e);
      session.finish(uri, id, ticket, outcome.verdict, outcome.note, quote);
    }
  };

  // ------------------------------------------------------------------
  // Commands.
  // ------------------------------------------------------------------

  /** The assumption a thread's title-bar command was invoked on. */
  const target = (thread: vscode.CommentThread | undefined): { uri: string; id: string } | null => {
    const id = thread ? threads.idFor(thread) : null;
    return thread && id ? { uri: keyOf(thread.uri), id } : null;
  };

  const register = (command: string, run: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, run));
  };

  /** A draft's `contextValue` says which submit buttons it shows (see the
   *  `comments/commentThread/context` menu). A draft opened from the gutter
   *  has none, and offers both. A draft for a note about the whole file
   *  offers only **Save Note**. */
  type Draft = EntryKind | 'file';
  const DRAFTS: Record<Draft, { contextValue: string; label: string }> = {
    assumption: { contextValue: 'draft-assumption', label: 'New assumption' },
    scratch: { contextValue: 'draft-scratch', label: 'New note' },
    file: { contextValue: 'draft-file', label: 'New note about this file' },
  };

  const draftOn = (doc: vscode.TextDocument, range: vscode.Range, kind: Draft): vscode.CommentThread => {
    const thread = controller.createCommentThread(doc.uri, range, []);
    thread.contextValue = DRAFTS[kind].contextValue;
    thread.label = DRAFTS[kind].label;
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return thread;
  };

  const openDraft = async (kind: EntryKind): Promise<vscode.CommentThread | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isTracked(editor.document)) return;
    await opened(editor.document);
    const selection = editor.selection;
    const range = selection.isEmpty ? editor.document.lineAt(selection.active.line).range : selection;
    return draftOn(editor.document, range, kind);
  };

  /** A note about the whole file is drafted at the top of it, where it will
   *  sit. `uri` is the file the Explorer's menu was opened on, if it was. */
  const openFileDraft = async (uri?: vscode.Uri): Promise<vscode.CommentThread | undefined> => {
    const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!doc || !isTracked(doc)) return;
    const editor = await vscode.window.showTextDocument(doc);
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    await opened(doc);
    return draftOn(doc, new vscode.Range(0, 0, 0, 0), 'file');
  };

  /** Turns a draft into an entry of `kind` in place. Only an assumption is
   *  then checked. */
  const submit = async (reply: vscode.CommentReply, kind: EntryKind): Promise<void> => {
    const text = reply.text.trim();
    const thread = reply.thread;
    if (!text || !thread.range) return;
    const doc = await vscode.workspace.openTextDocument(thread.uri);
    await opened(doc);
    if (thread.contextValue === DRAFTS.file.contextValue) {
      threads.adoptNext(thread);
      session.add(keyOf(doc.uri), null, text, 'scratch');
      return;
    }
    const span = spanOf(doc, thread.range);
    if (!span) {
      void vscode.window.showInformationMessage(
        `Select some code for the ${kind === 'scratch' ? 'note' : 'assumption'} to be about.`,
      );
      return;
    }
    threads.adoptNext(thread);
    const entry = session.add(keyOf(doc.uri), span, text, kind);
    await check(keyOf(doc.uri), entry.id);
  };

  register('monolog.addAssumption', () => openDraft('assumption'));

  register('monolog.addScratchNote', () => openDraft('scratch'));

  register('monolog.addFileNote', (uri?: vscode.Uri) => openFileDraft(uri instanceof vscode.Uri ? uri : undefined));

  register('monolog.submitAssumption', (reply: vscode.CommentReply) => submit(reply, 'assumption'));

  register('monolog.submitScratchNote', (reply: vscode.CommentReply) => submit(reply, 'scratch'));

  register('monolog.cancelNewAssumption', (reply: vscode.CommentReply | vscode.CommentThread) => {
    const thread = 'thread' in reply ? reply.thread : reply;
    if (!threads.idFor(thread)) thread.dispose();
  });

  register('monolog.editClaim', (comment: ClaimComment) => threads.setEditing(comment, true));

  register('monolog.cancelEdit', (comment: ClaimComment) => threads.setEditing(comment, false));

  register('monolog.saveClaim', async (comment: ClaimComment) => {
    const claim = comment.text.trim();
    if (!claim) {
      void vscode.window.showInformationMessage(
        `${comment.kind === 'scratch' ? 'A note' : 'An assumption'} cannot be empty. ` +
          'Delete it from the thread title instead.',
      );
      return;
    }
    if (claim === comment.claim) {
      threads.setEditing(comment, false);
      return;
    }
    // Back to preview before the session announces the new claim, so the
    // redraw it triggers replaces this comment instead of preserving it.
    comment.mode = vscode.CommentMode.Preview;
    session.setClaim(comment.uri, comment.id, claim);
    await check(comment.uri, comment.id);
  });

  register('monolog.recheck', async (thread: vscode.CommentThread) => {
    const t = target(thread);
    if (t) await check(t.uri, t.id);
  });

  register('monolog.setNoteTitle', async (thread: vscode.CommentThread) => {
    const t = target(thread);
    const note = t ? session.get(t.uri, t.id) : null;
    if (!t || !note || kindOf(note) !== 'scratch') return;
    const title = await vscode.window.showInputBox({
      title: 'Note title',
      prompt: 'Shown as the heading, and when you hover over the note. Leave empty for none.',
      value: note.title ?? '',
    });
    if (title !== undefined) session.setTitle(t.uri, t.id, title);
  });

  register('monolog.resolve', (thread: vscode.CommentThread) => {
    const t = target(thread);
    if (t) session.resolve(t.uri, t.id);
  });

  register('monolog.reopen', (thread: vscode.CommentThread) => {
    const t = target(thread);
    if (t) session.reopen(t.uri, t.id);
  });

  register('monolog.delete', async (thread: vscode.CommentThread) => {
    const t = target(thread);
    const entry = t ? session.get(t.uri, t.id) : null;
    if (!t || !entry) return;
    const choice = await vscode.window.showWarningMessage(
      `Delete this ${kindOf(entry) === 'scratch' ? 'note' : 'assumption'}? What you wrote cannot be recovered.`,
      { modal: true },
      'Delete',
    );
    if (choice === 'Delete') session.remove(t.uri, t.id);
  });

  const setTagColorsShown = async (shown: boolean): Promise<void> => {
    tagColorsShown = shown;
    await context.workspaceState.update(TAG_COLORS_SHOWN, shown);
    await vscode.commands.executeCommand('setContext', TAG_COLORS_SHOWN, shown);
    redrawTags();
  };

  register('monolog.showTagColors', () => setTagColorsShown(true));

  register('monolog.hideTagColors', () => setTagColorsShown(false));

  register('monolog.setTagColor', async () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !isTracked(doc)) {
      void vscode.window.showInformationMessage('Open a file first: a tag\'s colour belongs to the folder the file is in.');
      return;
    }
    const uri = keyOf(doc.uri);
    const known = router.knownTags(uri, session.list(uri));
    if (known.length === 0) {
      void vscode.window.showInformationMessage('No tags yet. Write #tag in a note, then give the tag a colour.');
      return;
    }
    const colors = router.tagColors(uri);
    const swatch = (color: TagColor | undefined): vscode.ThemeIcon =>
      color === undefined
        ? new vscode.ThemeIcon('circle-outline')
        : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(`monolog.${tagPaint(color)}Border`));
    const tag = await vscode.window.showQuickPick(
      known.map((t) => ({ label: `#${t}`, tag: t, description: colors.get(t) ?? '', iconPath: swatch(colors.get(t)) })),
      { title: 'Set Tag Colour', placeHolder: 'Which tag?' },
    );
    if (!tag) return;
    const choice = await vscode.window.showQuickPick(
      [
        ...TAG_COLORS.map((color) => ({
          label: `${color[0]!.toUpperCase()}${color.slice(1)}`,
          color: color as TagColor | null,
          iconPath: swatch(color),
          description: colors.get(tag.tag) === color ? 'current' : '',
        })),
        { label: 'No colour', color: null, iconPath: swatch(undefined), description: '' },
      ],
      { title: `Colour for #${tag.tag}`, placeHolder: 'Shown on the code of every note tagged with it' },
    );
    if (!choice) return;
    const why = await router.setTagColor(uri, tag.tag, choice.color);
    if (why !== null) {
      void vscode.window.showErrorMessage(`The colour was not saved: ${why}.`);
      return;
    }
    redrawTags();
  });

  register('monolog.setApiKey', async () => {
    const key = await vscode.window.showInputBox({
      title: 'Anthropic API key',
      prompt: `Checked against ${settings.model} before it is saved. Stored in your system keychain.`,
      placeHolder: 'sk-ant-…',
      password: true,
      ignoreFocusOut: true,
    });
    if (!key?.trim()) return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking the key…' },
        () => verifyKey(key.trim(), settings.model),
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`The key was not saved. ${(e as Error).message}`);
      return;
    }
    await context.secrets.store(SECRET_KEY, key.trim());
    void vscode.window.showInformationMessage(`Key saved. Assumptions will be checked by ${settings.model}.`);
  });

  register('monolog.clearApiKey', async () => {
    await context.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('The Anthropic API key was removed from your keychain.');
  });

  register('monolog.pruneDeleted', async () => {
    const pruned = await router.prune(async (uri) => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.parse(uri));
        return true;
      } catch {
        return false;
      }
    });
    for (const uri of pruned) session.forget(uri);
    void vscode.window.showInformationMessage(
      pruned.length === 0
        ? 'No assumptions belong to deleted files.'
        : `Removed the assumptions of ${pruned.length} deleted file${pruned.length === 1 ? '' : 's'}.`,
    );
  });

  return {
    ready,
    storage: root,
    session,
    router,
    threads,
    fileNotes,
    tagColors,
    controller,
    flush: () => router.flush(),
    check,
  };
}

/** Pending writes are debounced; this is the exit that must not lose them. */
let flushOnExit: (() => Promise<void>) | null = null;

export function deactivate(): Promise<void> | undefined {
  return flushOnExit?.();
}
