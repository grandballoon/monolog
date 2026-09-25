/* Keeping a span on its code while the file is edited.
 *
 * In Recall's Obsidian port this was CodeMirror's job: a `Decoration.mark` is
 * mapped through every transaction. VS Code has no equivalent the extension
 * can own — decorations are redrawn from ranges we supply, and a comment
 * thread's range is not written back to us as the text moves — so the mapping
 * is done here, as a pure function over the change list VS Code reports.
 *
 * The rules are CodeMirror's mark semantics, which Recall already settled on:
 *
 *  - Text inserted against either boundary falls outside the span. Typing at
 *    the end of a highlighted line should not grow the assumption.
 *  - A replacement that straddles a boundary is excluded too: the boundary
 *    moves to the edge of the new text rather than into it.
 *  - A replacement of exactly the span keeps it, covering the new text. That
 *    is someone selecting the code an assumption is about and rewriting it,
 *    and the assumption should follow — `checkedQuote` is what then says the
 *    verdict is stale.
 *  - A span whose text is entirely deleted collapses, and a collapsed span is
 *    reported rather than kept at zero width. The assumption survives it;
 *    only its anchor is gone.
 */

/** One entry of `TextDocumentChangeEvent.contentChanges`, reduced to the
 *  offsets. `offset`/`length` address the document as it was before this
 *  change; `text` is what replaced that stretch. */
export interface TextChange {
  offset: number;
  length: number;
  text: string;
}

export interface Span {
  from: number;
  to: number;
}

/** Where a span's start lands. At the start of a replacement it stays put (the
 *  new text is inside the span), except for a pure insertion, which is pushed
 *  past (text typed against the boundary is outside it). */
function mapFrom(pos: number, change: TextChange): number {
  const start = change.offset;
  const end = change.offset + change.length;
  if (pos < start) return pos;
  if (pos === start) return change.length === 0 ? start + change.text.length : start;
  if (pos < end) return start + change.text.length;
  return pos + change.text.length - change.length;
}

/** Where a span's end lands. Mirror image of `mapFrom`: an insertion at the
 *  boundary stays outside, and an end swallowed by a deletion retreats to
 *  the start of it. */
function mapTo(pos: number, change: TextChange): number {
  const start = change.offset;
  const end = change.offset + change.length;
  if (pos <= start) return pos;
  if (pos < end) return start;
  return pos + change.text.length - change.length;
}

/** Maps a span through one change, or returns null if the change deleted it. */
export function mapSpan(span: Span, change: TextChange): Span | null {
  const from = mapFrom(span.from, change);
  const to = mapTo(span.to, change);
  return from < to ? { from, to } : null;
}

/** Maps a span through every change of one event, in the order given.
 *
 *  VS Code's extension host applies `contentChanges` one after another, and
 *  that is the order they are mapped in here; the editor emits them sorted
 *  last-to-first, so each one's offsets are also valid against the original
 *  document. Either reading gives the same answer for that order. */
export function mapSpanThrough(span: Span, changes: readonly TextChange[]): Span | null {
  let current: Span | null = span;
  for (const change of changes) {
    if (current === null) return null;
    current = mapSpan(current, change);
  }
  return current;
}
