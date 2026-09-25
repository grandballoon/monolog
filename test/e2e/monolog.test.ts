/* Monolog inside a real VS Code.
 *
 * The headless suite proves the arithmetic; this proves the wiring — that the
 * commands, the comment threads, the document events and the storage do what
 * the pure modules assume they do. Each test drives the extension the way a
 * reader would, through its commands and real edits, and then looks at what a
 * reader would see: the thread, where it sits, and what it says.
 *
 * The one thing a test cannot do is type into a comment box, so a draft's
 * reply is handed to the submit command directly, exactly as VS Code does.
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import type { MonologTestApi } from '../../src/extension';
import type { ClaimComment } from '../../src/ui/threads';

const CODE = 'xs.reduce((a, b) => a + b, 0)';

let api: MonologTestApi;

function fixture(name: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'src', name);
}

/** Waits for something the extension does in response to an event, rather
 *  than guessing how long it takes. */
async function until(what: string, condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function openFixture(name: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(fixture(name));
  return vscode.window.showTextDocument(doc);
}

function select(editor: vscode.TextEditor, text: string): vscode.Selection {
  const from = editor.document.getText().indexOf(text);
  assert.notEqual(from, -1, `fixture should contain ${text}`);
  const selection = new vscode.Selection(
    editor.document.positionAt(from),
    editor.document.positionAt(from + text.length),
  );
  editor.selection = selection;
  return selection;
}

/** Writes an assumption about the selected code, as a reader would. */
async function assume(editor: vscode.TextEditor, text: string, claim: string): Promise<vscode.CommentThread> {
  select(editor, text);
  const draft = await vscode.commands.executeCommand<vscode.CommentThread>('monolog.addAssumption');
  assert.ok(draft, 'adding an assumption should open a draft thread');
  await vscode.commands.executeCommand('monolog.submitAssumption', { thread: draft, text: claim });
  return draft;
}

/** Writes a scratch note about the selected code, as a reader would. */
async function jot(editor: vscode.TextEditor, text: string, note: string): Promise<vscode.CommentThread> {
  select(editor, text);
  const draft = await vscode.commands.executeCommand<vscode.CommentThread>('monolog.addScratchNote');
  assert.ok(draft, 'adding a note should open a draft thread');
  assert.equal(draft.contextValue, 'draft-scratch');
  await vscode.commands.executeCommand('monolog.submitScratchNote', { thread: draft, text: note });
  return draft;
}

function claimOf(thread: vscode.CommentThread): ClaimComment {
  return thread.comments[0] as ClaimComment;
}

function bodyOf(comment: vscode.Comment): string {
  return typeof comment.body === 'string' ? comment.body : comment.body.value;
}

suiteSetup(async () => {
  const extension = vscode.extensions.getExtension<MonologTestApi>('lukeconley.monolog');
  assert.ok(extension, 'the extension should be installed in the test instance');
  api = await extension.activate();
  await api.ready;
});

teardown(async () => {
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (const uri of api.session.uris()) {
    for (const a of api.session.list(uri)) api.session.remove(uri, a.id);
  }
  await api.flush();
});

suite('Writing an assumption', () => {
  test('the draft becomes the assumption, on exactly the selected code', async () => {
    const editor = await openFixture('total.ts');
    const selection = select(editor, CODE);
    const thread = await assume(editor, CODE, 'Sums the array, starting from zero.');

    assert.equal(thread.canReply, false, 'a written assumption has no reply box');
    assert.equal(thread.contextValue, 'assumption');
    assert.ok(thread.range?.isEqual(selection), 'the thread sits on the selected code');
    assert.equal(bodyOf(claimOf(thread)), 'Sums the array, starting from zero.');

    const [assumption] = api.session.list(editor.document.uri.toString());
    assert.equal(assumption?.quote, CODE);
  });

  test('in demo mode it is saved and says it was not checked', async () => {
    const editor = await openFixture('total.ts');
    const thread = await assume(editor, CODE, 'Sums the array.');

    assert.equal(thread.label, 'Not checked');
    assert.equal(thread.comments.length, 2);
    assert.match(bodyOf(thread.comments[1]!), /Demo mode is on/);
  });

  test('an assumption from the gutter covers its lines, without their indentation', async () => {
    const editor = await openFixture('total.ts');
    const line = editor.document.getText().split('\n').findIndex((l) => l.includes('return xs[0]'));
    editor.selection = new vscode.Selection(line, 0, line, 0);
    const draft = await vscode.commands.executeCommand<vscode.CommentThread>('monolog.addAssumption');
    await vscode.commands.executeCommand('monolog.submitAssumption', { thread: draft, text: 'Never throws.' });

    const [assumption] = api.session.list(editor.document.uri.toString());
    assert.equal(assumption?.quote, 'return xs[0];');
  });

  test('cancelling a draft leaves nothing behind', async () => {
    const editor = await openFixture('total.ts');
    select(editor, CODE);
    const draft = await vscode.commands.executeCommand<vscode.CommentThread>('monolog.addAssumption');
    await vscode.commands.executeCommand('monolog.cancelNewAssumption', { thread: draft, text: '' });
    assert.deepEqual(api.session.list(editor.document.uri.toString()), []);
  });
});

suite('Writing a scratch note', () => {
  test('the draft becomes a note on the selected code, kept as plain text and never checked', async () => {
    const editor = await openFixture('total.ts');
    const selection = select(editor, CODE);
    const thread = await jot(editor, CODE, 'Why not a *for* loop? # ask');

    assert.equal(thread.contextValue, 'scratch');
    assert.equal(thread.label, 'Note');
    assert.equal(thread.canReply, false);
    assert.ok(thread.range?.isEqual(selection), 'the thread sits on the selected code');
    assert.equal(thread.comments.length, 1, 'a note has no answer below it');
    assert.equal(claimOf(thread).body, 'Why not a *for* loop? # ask', 'the body is a plain string, not Markdown');

    const [note] = api.session.list(editor.document.uri.toString());
    assert.equal(note?.kind, 'scratch');
    assert.equal(api.session.isRunning(note!.id), false);
  });

  test('a draft from the gutter can be saved as a note', async () => {
    const editor = await openFixture('total.ts');
    const line = editor.document.getText().split('\n').findIndex((l) => l.includes('return xs[0]'));
    // The gutter's + opens a thread with no context value of its own.
    const draft = api.controller.createCommentThread(editor.document.uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('monolog.submitScratchNote', { thread: draft, text: 'Edge case.' });
    assert.equal(draft.contextValue, 'scratch', 'the gutter draft itself becomes the note');

    const [note] = api.session.list(editor.document.uri.toString());
    assert.equal(note?.kind, 'scratch');
    assert.equal(note?.quote, 'return xs[0];');
  });

  test('editing a note keeps it a note, and asking to check it does nothing', async () => {
    const editor = await openFixture('total.ts');
    const thread = await jot(editor, CODE, 'First thought.');
    const comment = claimOf(thread);
    await vscode.commands.executeCommand('monolog.editClaim', comment);
    comment.body = 'Second thought.';
    await vscode.commands.executeCommand('monolog.saveClaim', comment);
    await until('the note to read its new text', () => bodyOf(claimOf(thread)) === 'Second thought.');

    await vscode.commands.executeCommand('monolog.recheck', thread);
    assert.equal(thread.label, 'Note');
    assert.equal(thread.comments.length, 1);
  });

  test('a titled note is headed by its title, and the title can be taken away', async () => {
    const editor = await openFixture('total.ts');
    const thread = await jot(editor, CODE, 'Check the fold.');
    const uri = editor.document.uri.toString();
    const [note] = api.session.list(uri);

    api.session.setTitle(uri, note!.id, 'Fold');
    assert.equal(thread.label, 'Fold');
    api.session.setTitle(uri, note!.id, '');
    assert.equal(thread.label, 'Note');
  });

  test('a note follows its code and can be resolved', async () => {
    const editor = await openFixture('total.ts');
    const thread = await jot(editor, CODE, 'Keep an eye on this.');
    const line = thread.range!.start.line;
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// One.\n'));
    await until('the note to move down a line', () => thread.range?.start.line === line + 1);

    await vscode.commands.executeCommand('monolog.resolve', thread);
    assert.equal(thread.contextValue, 'scratch-resolved');
    assert.equal(thread.label, 'Resolved · Note');
  });
});

suite('Following the code', () => {
  test('the thread moves with its code when lines are added above', async () => {
    const editor = await openFixture('total.ts');
    const thread = await assume(editor, CODE, 'Sums the array.');
    const line = thread.range!.start.line;

    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// One.\n// Two.\n'));
    await until('the thread to move down two lines', () => thread.range?.start.line === line + 2);
    assert.equal(editor.document.getText(thread.range), CODE);
  });

  test('deleting the code detaches the thread, and undo brings it back', async () => {
    const editor = await openFixture('total.ts');
    const thread = await assume(editor, CODE, 'Sums the array.');
    const range = thread.range!;

    await editor.edit((b) => b.delete(range));
    await until('the thread to lose its code', () => thread.range === undefined);
    assert.match(thread.label ?? '', /^Code not found/);

    await vscode.commands.executeCommand('undo');
    await until('the thread to find its code again', () => thread.range !== undefined);
    assert.equal(editor.document.getText(thread.range), CODE);
    assert.equal(thread.label, 'Not checked');
  });

  test('a changed verdict-bearing span is reported stale, not silently kept', async () => {
    const editor = await openFixture('total.ts');
    const thread = await assume(editor, CODE, 'Sums the array.');
    const uri = editor.document.uri.toString();
    const [assumption] = api.session.list(uri);
    // Stand in for a real answer: demo mode never gives a verdict.
    const ticket = api.session.begin(uri, assumption!.id)!;
    api.session.finish(uri, assumption!.id, ticket, 'solid', 'It does.', CODE);
    assert.equal(thread.label, 'Solid');

    const plus = editor.document.getText().indexOf('a + b') + 2;
    await editor.edit((b) => b.replace(new vscode.Range(editor.document.positionAt(plus), editor.document.positionAt(plus + 1)), '-'));
    await until('the verdict to go stale', () => thread.label === 'Solid · code changed since');
  });
});

suite('Editing an assumption', () => {
  test('a rewritten assumption replaces the old one and is checked again', async () => {
    const editor = await openFixture('total.ts');
    const thread = await assume(editor, CODE, 'Sums the array.');
    const comment = claimOf(thread);

    await vscode.commands.executeCommand('monolog.editClaim', comment);
    assert.equal(comment.mode, vscode.CommentMode.Editing);
    comment.body = 'Returns 0 for an empty array.';
    await vscode.commands.executeCommand('monolog.saveClaim', comment);

    await until('the thread to show the new assumption', () => bodyOf(claimOf(thread)) === 'Returns 0 for an empty array.');
    assert.equal(claimOf(thread).mode, vscode.CommentMode.Preview);
    assert.equal(api.session.list(editor.document.uri.toString())[0]?.claim, 'Returns 0 for an empty array.');
    assert.equal(thread.label, 'Not checked');
  });

  test('it can be edited again and again', async () => {
    const editor = await openFixture('total.ts');
    const thread = await assume(editor, CODE, 'One.');
    for (const claim of ['Two.', 'Three.', 'Four.']) {
      const comment = claimOf(thread);
      await vscode.commands.executeCommand('monolog.editClaim', comment);
      comment.body = claim;
      await vscode.commands.executeCommand('monolog.saveClaim', comment);
      await until(`the claim to read ${claim}`, () => bodyOf(claimOf(thread)) === claim);
    }
  });

  test('cancelling an edit restores what was there', async () => {
    const editor = await openFixture('total.ts');
    const thread = await assume(editor, CODE, 'Sums the array.');
    const comment = claimOf(thread);
    await vscode.commands.executeCommand('monolog.editClaim', comment);
    comment.body = 'Something half-typed';
    await vscode.commands.executeCommand('monolog.cancelEdit', comment);
    assert.equal(bodyOf(claimOf(thread)), 'Sums the array.');
    assert.equal(claimOf(thread).mode, vscode.CommentMode.Preview);
  });

  test('resolving marks the thread resolved, and reopening undoes it', async () => {
    const editor = await openFixture('total.ts');
    const thread = await assume(editor, CODE, 'Sums the array.');
    await vscode.commands.executeCommand('monolog.resolve', thread);
    assert.equal(thread.state, vscode.CommentThreadState.Resolved);
    assert.equal(thread.contextValue, 'assumption-resolved');
    await vscode.commands.executeCommand('monolog.reopen', thread);
    assert.equal(thread.state, vscode.CommentThreadState.Unresolved);
  });
});

suite('Keeping assumptions', () => {
  test('they reach disk, outside the workspace', async () => {
    const editor = await openFixture('total.ts');
    await assume(editor, CODE, 'Sums the array.');
    await api.flush();

    const folder = vscode.Uri.joinPath(api.storage, 'assumptions');
    const names = (await vscode.workspace.fs.readDirectory(folder)).map(([name]) => name);
    assert.equal(names.length, 1);
    const record = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, names[0]!))));
    assert.equal(record.uri, editor.document.uri.toString());
    assert.equal(record.assumptions[0].claim, 'Sums the array.');
    assert.ok(!api.storage.fsPath.startsWith(vscode.workspace.workspaceFolders![0]!.uri.fsPath));
  });

  test('a renamed file takes its assumptions with it', async () => {
    const editor = await openFixture('total.ts');
    await assume(editor, CODE, 'Sums the array.');
    const from = fixture('total.ts');
    const to = fixture('sum.ts');

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(from, to);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await until('the assumption to follow the rename', () => api.session.list(to.toString()).length === 1);
    assert.deepEqual(api.session.list(from.toString()), []);
    await until('a thread on the renamed file', () => api.threads.threadsFor(to.toString()).length === 1);

    const back = new vscode.WorkspaceEdit();
    back.renameFile(to, from);
    await vscode.workspace.applyEdit(back);
    await until('the assumption to follow it back', () => api.session.list(from.toString()).length === 1);
  });

  test('removing an assumption removes its thread', async () => {
    const editor = await openFixture('total.ts');
    await assume(editor, CODE, 'Sums the array.');
    const uri = editor.document.uri.toString();
    const [assumption] = api.session.list(uri);
    api.session.remove(uri, assumption!.id);
    assert.deepEqual(api.threads.threadsFor(uri), []);
  });
});

suite('Tags and the metadata file', () => {
  const metadata = (): vscode.Uri =>
    vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, '.monolog', 'metadata.json');

  async function readMetadata(): Promise<{
    tags: Record<string, { color?: string }>;
    notes: { path: string; id: string; span?: unknown; tags: string[]; text: string }[];
  }> {
    return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(metadata())));
  }

  teardown(async () => {
    const uri = fixture('total.ts').toString();
    for (const tag of api.router.knownTags(uri)) await api.router.setTagColor(uri, tag, null);
    await vscode.commands.executeCommand('monolog.showTagColors');
  });

  test('a note reaches the workspace\'s metadata file, with its tags, and an assumption does not', async () => {
    const editor = await openFixture('total.ts');
    await jot(editor, CODE, 'Allocates nothing. #perf #Hot-path');
    await assume(editor, 'return xs[0];', 'Never throws.');
    await api.flush();

    const { notes } = await readMetadata();
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.path, 'src/total.ts');
    assert.deepEqual(notes[0]!.tags, ['perf', 'hot-path']);
    assert.equal(notes[0]!.text, 'Allocates nothing. #perf #Hot-path');
  });

  test('a note about the whole file sits at its top, has no span, and marks the file in the Explorer', async () => {
    const editor = await openFixture('total.ts');
    const draft = await vscode.commands.executeCommand<vscode.CommentThread>('monolog.addFileNote');
    assert.ok(draft, 'adding a file note should open a draft thread');
    assert.equal(draft.contextValue, 'draft-file');
    assert.ok(draft.range?.isEqual(new vscode.Range(0, 0, 0, 0)));
    await vscode.commands.executeCommand('monolog.submitScratchNote', { thread: draft, text: 'Summing helpers. #area/math' });

    assert.equal(draft.contextValue, 'scratch', 'the draft itself becomes the note');
    assert.equal(draft.label, 'File note');
    const uri = editor.document.uri.toString();
    const [note] = api.session.list(uri);
    assert.equal(note?.scope, 'file');

    const mark = api.fileNotes.provideFileDecoration(editor.document.uri);
    assert.equal(mark?.badge, '✎');
    assert.equal(mark?.tooltip, 'Summing helpers. #area/math');
    assert.equal(mark?.color, undefined, 'no colour until the tag has one');

    await api.flush();
    const { notes } = await readMetadata();
    assert.equal(notes[0]!.span, undefined);
  });

  test('a tag\'s colour is kept in the metadata file, and the toggle hides and shows it', async () => {
    const editor = await openFixture('total.ts');
    await jot(editor, CODE, 'Hot. #perf');
    const uri = editor.document.uri.toString();

    assert.equal(await api.router.setTagColor(uri, 'perf', 'red'), null);
    assert.deepEqual([...(api.tagColors(uri) ?? [])], [['perf', 'red']]);
    assert.deepEqual((await readMetadata()).tags, { perf: { color: 'red' } });

    await vscode.commands.executeCommand('monolog.hideTagColors');
    assert.equal(api.tagColors(uri), null);
    await vscode.commands.executeCommand('monolog.showTagColors');
    assert.deepEqual([...(api.tagColors(uri) ?? [])], [['perf', 'red']]);
  });

  test('a file-level note takes its tag\'s colour in the Explorer', async () => {
    const editor = await openFixture('total.ts');
    const draft = await vscode.commands.executeCommand<vscode.CommentThread>('monolog.addFileNote');
    await vscode.commands.executeCommand('monolog.submitScratchNote', { thread: draft, text: '#legacy' });
    await api.router.setTagColor(editor.document.uri.toString(), 'legacy', 'orange');

    const color = api.fileNotes.provideFileDecoration(editor.document.uri)?.color;
    assert.equal(color?.id, 'monolog.tagOrangeBorder');
    await vscode.commands.executeCommand('monolog.hideTagColors');
    assert.equal(api.fileNotes.provideFileDecoration(editor.document.uri)?.color, undefined);
  });

  test('a note written into the metadata file from outside appears on its code', async () => {
    const editor = await openFixture('total.ts');
    const uri = editor.document.uri.toString();
    const body = {
      version: 1,
      tags: {},
      notes: [{ path: 'src/total.ts', id: 'from-a-pull', span: { from: 0, to: 0, quote: 'return xs[0];' }, tags: [], text: 'Pulled.' }],
    };
    await vscode.workspace.fs.writeFile(metadata(), new TextEncoder().encode(JSON.stringify(body)));

    await until('the pulled note to arrive', () => api.session.get(uri, 'from-a-pull') !== null);
    await until('a thread for it on its code', () => {
      const thread = api.threads.threadFor('from-a-pull');
      return !!thread?.range && editor.document.getText(thread.range) === 'return xs[0];';
    });
  });
});
