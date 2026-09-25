# Monolog

Write down what you assume about the code you are reading, and have each assumption checked against the code — without touching the file.

Monolog is Recall (`../recall`) moved into VS Code.
Recall checks what you wrote from memory, span by span.
Monolog turns that around: the code is the ground truth, and what is on trial is your belief about it.

## Using it

Select some code, right-click, and choose **Add Assumption About Code**.
With nothing selected it takes the line the cursor is on.
To give it a hotkey, open **Keyboard Shortcuts** (Cmd+K Cmd+S), search for `monolog.addAssumption`, and press the keys you want.
You can also hover in the gutter and click **+** to start one on whole lines.
Type what you believe that code does, guarantees, or is for, and press **Record Assumption**.

The assumption opens as a thread between the lines, so it pushes the code down rather than covering it.
Nothing Monolog shows is drawn on top of code unless you ask for it: the one exception is a note's title, below.
Collapse the thread and it becomes a gutter icon; the code it is about keeps a coloured underline, and a short summary sits past the end of its last line.
Click the gutter icon to open the thread again.

Claude reads the whole file and answers with one of five verdicts and a short note:

| Verdict | Colour | Meaning |
| --- | --- | --- |
| Incorrect | orange | The code contradicts the assumption. |
| Imprecise | yellow | Broadly right, but vague or misleading in a way that matters. |
| Incomplete | blue | Right as far as it goes, but it leaves out something that carries the meaning. |
| Solid | green | The code bears it out. |
| Can't tell from this file | purple | It depends on code the file does not contain. |

Grey means there is no current verdict: the check is running, was not made, or answered a question about code that has since changed.

Edit an assumption with the pencil on its comment as often as you like.
Each saved rewrite is checked afresh.
The thread's title bar has **Check Again**, **Mark Resolved** and **Delete**.
A resolved assumption keeps its thread but comes off the code.

Every assumption in the workspace is listed in VS Code's **Comments** panel, whether or not its file is open.

### Notes

Not everything you write about code is a claim to test.
For explanations, questions, reminders and anything else you want kept with the code, right-click and choose **Add Note About Code** instead, type, and press **Save Note**.
A thread opened from the gutter's **+** offers both **Record Assumption** and **Save Note**.

A note sits on its code exactly as an assumption does: between the lines, collapsible to a gutter icon, underlined in teal, summarised at the end of the line, and listed in the Comments panel.
It also has a teal note icon of its own in the gutter, beside the comment icon, so a note can be told from an assumption with its thread closed.
It follows its code through edits the same way.
It is kept as plain text, not Markdown, as long as you like, and is never checked: nothing in a note is sent to any service, whatever the settings.
Edit it with the pencil, and resolve or delete it from the title bar.

Give a note a title with **Set Title** in its title bar.
The title becomes the thread's heading and the start of its line-end summary, and it appears when you rest the pointer on the note's highlighted code or its summary.
An untitled note shows no hover; clear the title to take the hover away.

To write about a file as a whole, choose **Add Note About File** from the editor's or the Explorer's right-click menu.
The note opens at the top of the file and stays there, however the file is edited.
The Explorer marks the file with ✎, and shows the file's notes when you rest the pointer on it.

### Tags

Put `#tags` anywhere in a note: `#perf`, `#needs-review`, `#area/billing`.
A tag starts with a letter and runs until a space or punctuation; case is ignored, so `#Perf` is `#perf`.
`page#anchor`, `#123` and `&#39;` are not tags.
Typing `#` in a comment box offers the tags already in use.

Run **Monolog: Set Tag Colour…** to give a tag one of VS Code's chart colours: red, orange, yellow, green, blue, purple, cyan or magenta.
Every note tagged with it is then highlighted in that colour instead of teal, and a file whose note about the whole file carries it has its name coloured in the Explorer.
A note with several coloured tags takes the colour of the one it mentions first.

The eye button in the editor's title bar, shown when the file has a note with a coloured tag, hides and shows tag colours.
While they are hidden, notes are teal again.
**Monolog: Show Tag Colours** and **Hide Tag Colours** do the same from the Command Palette.

The colours are theme colours (`monolog.tagRedBackground`, `monolog.tagRedBorder`, and so on), and each underline defaults to the editor's own `charts.red`, `terminal.ansiCyan` and so on, so it follows your theme.

### The metadata file

Notes and tag colours are kept in `.monolog/metadata.json` at the root of the workspace folder, so they can be committed and shared with the code.
Every note in the folder is in that one file, with its path relative to the folder, the span it covers, its tags and its text:

```json
{
  "version": 1,
  "tags": { "perf": { "color": "red" } },
  "notes": [
    {
      "path": "src/total.ts",
      "id": "amg2x1k1",
      "span": { "from": 52, "to": 81, "quote": "xs.reduce((a, b) => a + b, 0)" },
      "tags": ["perf"],
      "text": "Allocates nothing. #perf"
    },
    {
      "path": "src/total.ts",
      "id": "amg2x9q2",
      "title": "Entry point",
      "tags": ["legacy"],
      "text": "Everything here is called from the CLI. #legacy"
    }
  ]
}
```

A note with no `span` is about the whole file.
`from` and `to` are character offsets; `quote` is the code itself, and is what puts a note back when the offsets no longer fit.
The file is written sorted, so the same notes always give the same bytes and a diff shows only what changed.
Editing code moves the spans of the notes below it, so the file changes along with the code.

Monolog watches the file.
A pull, a checkout or a hand edit shows up on the code straight away.
If the file changed on disk while one of your edits to the same source file was waiting to be written, the file on disk wins.
If it cannot be read — a merge conflict left in it, say — Monolog says so and will not write over it.
Notes you change meanwhile are kept privately, and go into the file once it is fixed.

A file outside every workspace folder has no metadata file, and its notes are kept privately, as assumptions are.

### When the code changes

An assumption follows its code as you edit: lines added above move it, edits inside it are part of it.
If an edit changes the code a verdict was given about, the verdict is kept but marked *code changed since* and drawn grey, until you check it again.
If the code is deleted, the assumption is kept, attached to the file as a whole, and titled *Code not found*.
It goes back on its own as soon as that code appears exactly once again — an undo, or the same lines pasted elsewhere.
A file renamed or deleted inside VS Code takes its assumptions and notes with it; a deleted file's wait for it to come back until you run **Monolog: Prune Assumptions for Deleted Files**, which removes both.

## Setting up

Run **Monolog: Set Anthropic API Key** from the Command Palette.
The key is tested against the chosen model before it is saved, and is stored in your system keychain through VS Code's secret storage.
Without a key, assumptions are still recorded and shown; they just say they were not checked.

| Setting | Default | |
| --- | --- | --- |
| `monolog.model` | `claude-sonnet-5` | The model that checks assumptions. `claude-opus-5` is the more careful, costlier reader. |
| `monolog.effort` | `default` | How much thinking a check may spend. Lower this before choosing a smaller model. |
| `monolog.demoMode` | `false` | Record assumptions without sending them anywhere. |
| `monolog.inlineSummary` | `true` | Show the verdict and a short excerpt at the end of the line. |

The highlight colours are theme colours (`monolog.solidBackground`, `monolog.solidBorder`, and so on), so they can be changed in `workbench.colorCustomizations`.

## What is sent, and what is kept

A check sends the whole file, with line numbers, plus the selected span and your assumption, to the Anthropic API.
Nothing else from the workspace is sent, and notes never are.

Assumptions, and Claude's answers to them, are stored as one JSON record per file in VS Code's private storage for the workspace, never in the workspace itself, so they cannot end up in a commit.

Notes and tag colours are written into the workspace, in `.monolog/metadata.json`, so that they can be committed.
If you want to keep them to yourself, add `.monolog/` to `.gitignore`.

## Developing

Use Node 22 (`nvm use` reads `.nvmrc`).

```sh
npm install
npm test            # the headless suite: checker, anchoring, store, session, presentation
npm run test:e2e    # the extension inside a real VS Code, against a copy of test/fixture
npm run check       # typecheck
npm run package     # build monolog.vsix
code --install-extension monolog.vsix
```

`npm run dev` rebuilds on change; press F5 in VS Code with this folder open to launch an Extension Development Host.

How the code is divided, and why, is in `DESIGN.md`.
