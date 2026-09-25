/* The highlight on an assumption's code, and its summary at the end of the
 * line — the two parts of an assumption that are always in view. A scratch
 * note also gets an icon of its own in the gutter.
 *
 * VS Code draws the comment icon for a collapsed thread in one colour for
 * every thread, and gives an extension no way to change it per thread. So a
 * note's icon is a separate gutter decoration in the note's colour, on the
 * same line as the comment icon, and shown whether the thread is open or not.
 *
 * None of them covers any of the file. The highlight is a wash behind the code with
 * an underline in the verdict's colour; the summary sits past the end of the
 * last line the assumption covers, where there is no code to hide. The full
 * thread opens between lines, as a comment thread does, and pushes the code
 * down rather than floating over it.
 *
 * There is no hover, with one exception the reader opts into. A hover is
 * drawn on top of the lines around the pointer, and nothing Monolog shows
 * unasked may hide any of the code. A note the reader has given a title shows
 * that title when the pointer rests on its code or its summary; an untitled
 * note, and every assumption, shows nothing. The hover cannot hang off the
 * gutter icon: VS Code shows an extension's decoration hovers only over text.
 *
 * Colours are contributed theme colours (`monolog.<paint>Background` and
 * `…Border` in package.json), so a theme or the reader's own
 * `workbench.colorCustomizations` can restyle them, and light, dark and high
 * contrast each get their own defaults. A note painted by its tag takes one
 * of the `monolog.tag<Colour>…` colours, whose borders default to VS Code's
 * own `charts.*` and terminal colours.
 */
import * as vscode from 'vscode';

import { kindOf, type Assumption } from '../store/format';
import type { TagColor } from '../tags/tags';
import { PAINTS, hoverTitle, isDrawn, paintFor, summaryText, type Paint } from './present';

function highlightType(paint: Paint): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(`monolog.${paint}Background`),
    borderColor: new vscode.ThemeColor(`monolog.${paint}Border`),
    borderStyle: 'none none solid none',
    borderWidth: '0 0 1px 0',
    overviewRulerColor: new vscode.ThemeColor(`monolog.${paint}Border`),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    // Typing against either end does not grow the highlight, matching how
    // the span itself is mapped through edits.
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

function hoverOf(a: Assumption): vscode.MarkdownString | undefined {
  const title = hoverTitle(a);
  return title === null ? undefined : new vscode.MarkdownString().appendText(title);
}

/** The position the summary hangs off: the end of the last line with any of
 *  the span on it. A span ending at the start of a line (a whole-line
 *  selection) belongs to the line before. */
function summaryAnchor(doc: vscode.TextDocument, a: Assumption): vscode.Range {
  let end = doc.positionAt(a.to);
  if (end.character === 0 && end.line > doc.positionAt(a.from).line) end = end.translate(-1);
  const line = doc.lineAt(end.line).range.end;
  return new vscode.Range(line, line);
}

export class Decorations implements vscode.Disposable {
  private readonly highlights = new Map<Paint, vscode.TextEditorDecorationType>(
    PAINTS.map((paint) => [paint, highlightType(paint)]),
  );
  private readonly summary = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly scratchGutter: vscode.TextEditorDecorationType;

  /** `media` turns a file name in `media/` into its URI. */
  constructor(media: (name: string) => vscode.Uri) {
    this.scratchGutter = vscode.window.createTextEditorDecorationType({
      light: { gutterIconPath: media('gutter-scratch-light.svg') },
      dark: { gutterIconPath: media('gutter-scratch-dark.svg') },
      gutterIconSize: 'contain',
    });
  }

  /** Draws `assumptions` in every visible editor showing `uri`. `colors`
   *  are the tag colours to paint notes with, or null to paint none. */
  draw(
    uri: string,
    assumptions: readonly Assumption[],
    isRunning: (id: string) => boolean,
    showSummary: boolean,
    colors: ReadonlyMap<string, TagColor> | null,
  ): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri) continue;
      this.drawIn(editor, assumptions, isRunning, showSummary, colors);
    }
  }

  private drawIn(
    editor: vscode.TextEditor,
    assumptions: readonly Assumption[],
    isRunning: (id: string) => boolean,
    showSummary: boolean,
    colors: ReadonlyMap<string, TagColor> | null,
  ): void {
    const doc = editor.document;
    const byPaint = new Map<Paint, vscode.DecorationOptions[]>(PAINTS.map((p) => [p, []]));
    const summaries: vscode.DecorationOptions[] = [];
    const gutter: vscode.DecorationOptions[] = [];
    const length = doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end);

    for (const a of assumptions) {
      if (!isDrawn(a) || a.to > length) continue;
      const running = isRunning(a.id);
      const paint = paintFor(a, running, colors);
      const hoverMessage = hoverOf(a);
      const anchor = summaryAnchor(doc, a);
      byPaint.get(paint)!.push({
        range: new vscode.Range(doc.positionAt(a.from), doc.positionAt(a.to)),
        hoverMessage,
      });
      if (kindOf(a) === 'scratch') gutter.push({ range: anchor });
      if (showSummary) {
        summaries.push({
          range: anchor,
          hoverMessage,
          renderOptions: {
            after: {
              contentText: summaryText(a, running),
              color: new vscode.ThemeColor(`monolog.${paint}Border`),
              fontStyle: 'italic',
              margin: '0 0 0 2.5em',
            },
          },
        });
      }
    }

    for (const [paint, type] of this.highlights) editor.setDecorations(type, byPaint.get(paint)!);
    editor.setDecorations(this.summary, summaries);
    editor.setDecorations(this.scratchGutter, gutter);
  }

  dispose(): void {
    for (const type of this.highlights.values()) type.dispose();
    this.summary.dispose();
    this.scratchGutter.dispose();
  }
}
