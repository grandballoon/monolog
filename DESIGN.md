# Monolog — design

Monolog is a fourth surface of Recall, in a repository of its own.
It is ported from Recall's Obsidian plugin (`recall/obs_port`), which had already split the product into pure modules and a thin host shell.
The pure modules came across almost whole; the shell is new.

## The one change of meaning

Recall checks a span of the reader's own writing.
Monolog checks the reader's writing *about* a span of code.

So an assumption has two texts where a Recall check had one: the **quote**, the code the span covers, and the **claim**, what the reader believes about it.
The code is the ground truth and is never assessed; the claim is what gets a verdict.

That change is carried by the prompt in `src/checker/protocol.ts`, and by one addition to the verdicts.
`unverifiable` ("can't tell from this file") exists because a claim about code often depends on code the file does not contain — who calls this, what that import does.
Recall's rule is that a confidently wrong correction is worse than none, and without this verdict the model would have to guess.

## Scratch notes

A scratch note is an assumption with nothing to check.
It is the same record, marked `kind: "scratch"`, so anchoring, mapping through edits, storage, renames and the Comments panel carry it with no code of their own.
The difference lives in three places, and nowhere else:

- `store/format.ts` defines the kind. A record without `kind` is an assumption, so records written before notes existed read unchanged; an unknown kind makes the record unreadable, and so never written over.
- `session.begin` refuses a note a ticket, and `check` in `extension.ts` returns before anything is sent. Either alone would keep a note off the network; both together mean no path to the checker has to remember.
- `ui/present.ts` gives a note its own status and paint, so every surface reads it as a note rather than as an assumption waiting on a check.

A note's thread shows its text as a plain string rather than Markdown, because it is a scratchpad: what is typed is what is shown.

A note may carry a `title`, set from its thread's title bar and never written on an assumption.
It is the note's heading wherever a heading is shown, and the only thing Monolog shows on hover (see above).

VS Code colours the comment icon of a collapsed thread by the thread's state alone, the same for every thread, and offers no way to change it for one.
So a note draws its own icon in the glyph margin, in its colour, on the line where VS Code puts the comment icon (`ui/decorations.ts`).
Thread context values are `assumption`, `scratch`, and either with `-resolved`, and the title bar's commands in `package.json` match on them; **Check Again** matches only `assumption`.
Drafts carry `draft-assumption` or `draft-scratch` to choose their submit button, and a gutter draft carries neither and offers both. A draft for a note about the whole file carries `draft-file`, and offers only **Save Note**.

## Tags, whole-file notes, and the metadata file

Notes are the reader's metadata about the code, and are shared with the repository; assumptions are the reader's own, and are not.
That one split decides where everything new lives.

**Tags are part of the text.**
A note's tags are the `#tags` its text mentions (`tags/tags.ts`), so there is one thing to edit and nothing to keep in step.
The grammar requires a tag to start a word and start with a letter, so URLs, issue numbers and HTML entities never colour a note.
Only notes have tags; an assumption's `#` is just text.

**A note can be about the whole file.**
It is the same record with `scope: "file"`, and only a note may have it.
It has no span, so anchoring, mapping and re-anchoring pass it by, and it is never lost.
Its thread sits at the top of the file, on an empty range at 0:0, where the reader meets it on opening the file; `ui/explorer.ts` marks the file in the Explorer, because there is no code to highlight.

**Colours are the editor's.**
A tag's colour is one of eight names: VS Code's `charts.*` colours and the terminal's cyan and magenta, which are the palette VS Code offers extensions.
Each has a contributed `monolog.tag<Colour>Border` that defaults to the editor's colour, and a `…Background` wash, because a theme colour cannot be made translucent by an extension.
A note is painted by the first tag it mentions that has a colour (`ui/present.ts`), so the writer decides which of several wins.
Hiding tag colours paints every note as a plain note again; it is remembered per workspace.

**The metadata file.**
Each workspace folder has one, `.monolog/metadata.json`, holding every note in the folder and the tags' colours (`store/repoFormat.ts`).
It is a published format: relative paths, tags written out beside the text, nothing only this machine knows, written sorted so the same notes give the same bytes.
Whatever else reads it — a script, a dashboard, a query across repositories — needs nothing from Monolog to understand it.

Unlike the private store, it has other writers, so `store/repo.ts` merges instead of overwriting.
Every read and write compares the disk, one path at a time, with what it held when it last read or wrote the file.
A path the disk left alone keeps the session's notes.
A path the disk changed takes the disk's, and any unwritten change to that path is dropped.
The file wins because the likeliest cause is a checkout, and a checkout should show the checked-out notes.
The window where this drops a change is the save delay, about a second.

A file watcher calls the same merge when the file changes on disk, and the session replaces the changed files' notes (`session.replaceNotes`), leaving their assumptions alone.

The rule that an unreadable record is never written over holds for the metadata file too, and matters more: a merge conflict leaves one behind.
While it is unreadable, notes that change are kept in private storage, and they win over the file's copy on loading.
When the file can be read again, or at startup, `store/router.ts` moves privately held notes into it, and takes them out of private storage only once they are written.
The same path moves notes written before the metadata file existed.

`StoreRouter` is the one store the session sees.
It splits each file's entries on the way out and joins them on the way in, and it asks an injected `RepoLocator` which folder a file is in, so none of this imports `vscode`.

## Modules

Everything under `src/` except `extension.ts` and `src/ui/` imports nothing from `vscode`.
The test build enforces that: it bundles with nothing external, so a pure module that reaches for `vscode` fails to build rather than quietly becoming untestable.

| Module | Role | Knows about |
| --- | --- | --- |
| `anchor/mapping.ts` | Maps a span through an edit. | Nothing. |
| `anchor/anchoring.ts` | Finds a span again by its quote. Verbatim from Recall. | Nothing. |
| `checker/protocol.ts` | The request, the reading of the answer, the error codes. | The SDK's types and error classes. |
| `checker/index.ts` | Sends one check. | The SDK. |
| `check/outcome.ts` | What an assumption says when there is no verdict. | The checker's errors. |
| `store/format.ts` | The record on disk, and how to read it safely. | Nothing. |
| `store/store.ts` | One record per file, through an injected adapter. | The format. |
| `store/repoFormat.ts` | The metadata file on disk, and how to read it safely. | The record format, tags. |
| `store/repo.ts` | One folder's metadata file, merged with the disk. | Its format. |
| `store/router.ts` | Sends notes to the metadata file and assumptions to private storage. | Both stores. |
| `tags/tags.ts` | The tag grammar and the colour palette. | Nothing. |
| `session/session.ts` | Every file's assumptions, live: anchoring, edits, checks in flight. | The store, mapping, anchoring. |
| `settings/settings.ts` | Normalises the configuration. | The checker's model list. |
| `ui/present.ts` | The words and colour for every state. | The format. |
| `ui/threads.ts` | Draws assumptions as comment threads. | `vscode`, the session. |
| `ui/decorations.ts` | Draws highlights and line-end summaries. | `vscode`, presentation. |
| `ui/explorer.ts` | Marks files with whole-file notes in the Explorer. | `vscode`, presentation. |
| `ui/tagCompletion.ts` | Offers known tags after `#` in a comment box. | `vscode`, tags. |
| `ui/adapter.ts` | A store's disk, over `workspace.fs`: private storage, or a workspace folder. | `vscode`. |
| `extension.ts` | Listens to VS Code and wires the rest together. | Everything. |

Data flows one way.
VS Code events and commands call the session; the session changes its state, queues a write, and raises `onChange`; `extension.ts` answers that by redrawing the threads and decorations for that file.
Nothing draws in response to a command directly, so there is one path from state to screen.

## What VS Code gave, and what it took

**The popup.**
Comment threads are the surface the brief asked for: they open between lines and push the code down instead of floating over it, they collapse to a gutter icon, their comments edit in place, and the Comments panel lists every thread in the workspace.
That panel is Recall's side leaf, provided by the editor.
Nothing Monolog draws may cover code unasked, so there is no hover: a hover floats over the lines around the pointer.
The one exception is opted into: a note the reader has titled shows its title on hover over its code and its summary.
It cannot hang off the gutter icon instead, because VS Code shows an extension's decoration hovers only over text.
Everything is either a view zone that makes room for itself (the thread), a wash and underline behind the code (the highlight), or text past the end of a line (the summary).
One thread is one assumption, with the claim as its first comment and the answer as its second; there is no reply box once the claim is written, because rewriting the claim is how the conversation moves.
Recall's nested questions about a card's note do not carry over.

**The key goes back in the keychain.**
Recall's desktop app kept the API key in the OS keychain; its Obsidian port could not, and kept it in a file outside the vault.
VS Code's `SecretStorage` is the keychain, and the extension host is not a webview, so the original constraint holds again.

**The SDK instead of raw HTTP.**
The Obsidian port built HTTP by hand because a plugin runs in the renderer, where CORS blocks the API.
An extension runs in Node, so the official SDK works, and brings typed errors, retries and timeouts.
`protocol.ts` still owns the request shape, which is what keeps it assertable without a network.

**Mapping through edits is ours again.**
In Obsidian, CodeMirror mapped a decoration through every edit.
VS Code tracks its own decorations, but neither decorations nor comment threads report their moved ranges back to the extension, so the span offsets would drift from what is drawn.
`anchor/mapping.ts` maps them through each `contentChanges` list with CodeMirror's mark rules, so the Obsidian port's reasoning about boundaries still holds.

**One state per file.**
VS Code has one `TextDocument` per file however many editors show it, so the session holds one copy per file and there is nothing to broadcast between views.

## Rules kept from Recall

- A check that did not happen leaves the verdict null, and the highlight grey. The code is never labelled by a check that did not run.
- An assumption survives its span being deleted. Losing an anchor never deletes the writing.
- An assumption goes back by quote only where the quote appears exactly once. Showing it against the wrong code is worse than leaving it unplaced.
- A record that cannot be read is never written over. Saving is turned off for that one file, and the reader is told.
- A deleted file's assumptions are kept, marked, until the file comes back or the reader prunes them. The prune repairs a stale mark instead of trusting it.

## Rules new here

**Staleness.**
A verdict records the code it was given against (`checkedQuote`).
When the span's code stops matching it, ignoring whitespace, the verdict is shown as *code changed since* and drawn grey.
It is not re-checked automatically: that would spend tokens on every keystroke inside a span.
Only the span is compared; a change elsewhere in the file that alters the span's meaning goes unnoticed.

**Re-anchoring is automatic.**
Recall re-anchored lost checks only when asked, because moving highlights in a contenteditable surprised people.
Here a lost assumption is retried against the document shortly after each edit, so an undo, or cutting code and pasting it elsewhere, brings the assumption along.
The exactly-once rule is what keeps that from guessing.

**Checks in flight carry a ticket.**
Rewriting a claim while its previous check is still running starts a new check; the old answer arrives to a question nobody is asking any more, and is dropped.

**Startup opens every file with assumptions.**
The Comments panel should list every assumption, not only those in open files, and a thread needs a document to be placed.
So at startup each record's file is opened as a document, which shows nothing to the reader.
This is linear in the number of files that have assumptions.

## Storage

Notes live in each workspace folder's `.monolog/metadata.json`, described above.
Assumptions, and notes on files outside every workspace folder, live in private records.

Records live in `context.storageUri` — VS Code's private storage for this workspace — under `assumptions/`, named by an FNV-1a hash of the file's URI.
Each record carries its URI, so a hash collision is detected rather than serving another file's assumptions.
Writes are debounced, go to a temporary file, and are renamed into place.

Keying by URI means the storage belongs to this checkout on this machine.
It does not travel with the repository, and a file renamed outside VS Code (a `git mv` in a terminal, a checkout that moves files) loses its assumptions' association; they stay on disk as a record for a path that no longer exists.
The same rename leaves a note in the metadata file under the old path, where the prune command finds it.

## Known limits

- The live API call has not been exercised against a real key: the E2E suite runs in demo mode, and the request shape is covered by the SDK's types and `protocol.test.ts`.
- Several assumptions ending on the same line put their summaries side by side at the end of it.
- Only `file:` documents take assumptions. Untitled buffers and diff views have nowhere durable for one to live.
- The metadata file carries character offsets, so editing code rewrites the offsets of the notes below the edit, and the file shows up in the diff alongside the code. Opening a file whose code was changed elsewhere re-anchors its notes and writes the new offsets.
- A folder's tags are its own. The same tag in two folders of one workspace can have two colours.
- Querying the metadata files of several repositories from outside is not built yet. The file format is shaped for it: relative paths, explicit tags, and nothing machine-specific.
