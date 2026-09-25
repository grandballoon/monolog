/* Putting an assumption back on its code when the stored offsets no longer fit.
 *
 * Live edits are mapped through `mapping.ts`, so this is not the everyday
 * path. It is the reopen path, for a file edited while nobody was watching,
 * and the repair path for a span an edit deleted and a later edit (an undo, a
 * paste of the same lines elsewhere) put back. Ported from Recall's
 * `findQuote`, so both tools put a check back in the same place by the same
 * rules.
 */

export interface Anchor {
  /** Offsets into the document as it was when last written. */
  from: number;
  to: number;
  /** The code the assumption was written about. */
  quote: string;
}

export type Resolution =
  | { kind: 'exact'; from: number; to: number }
  | { kind: 'quote'; from: number; to: number }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'absent' };

export interface QuoteMatch {
  count: number;
  from: number;
  to: number;
}

/** Whitespace is normalised on both sides, so re-indenting a block or
 *  reflowing a line does not cost an assumption its code. `points` maps each
 *  kept character back to where it sits in the document. */
function textIndex(doc: string): { norm: string; points: number[] } {
  const points: number[] = [];
  let norm = '';
  let gap = false;
  for (let i = 0; i < doc.length; i++) {
    const ch = doc[i]!;
    if (/\s/.test(ch)) {
      gap = norm.length > 0;
      continue;
    }
    if (gap) {
      norm += ' ';
      points.push(i);
      gap = false;
    }
    norm += ch;
    points.push(i);
  }
  return { norm, points };
}

export function normaliseQuote(quote: string): string {
  return String(quote ?? '').replace(/\s+/g, ' ').trim();
}

/** An assumption is put back only where its quote appears exactly once.
 *
 *  An ambiguous or absent quote is left alone and reported, because an
 *  assumption shown against the wrong code is worse than one left unplaced. */
export function findQuote(doc: string, quote: string): QuoteMatch {
  const needle = normaliseQuote(quote);
  if (needle.length < 3) return { count: 0, from: -1, to: -1 };

  const { norm, points } = textIndex(doc);
  let count = 0;
  let at = -1;
  let from = 0;
  let i: number;
  while ((i = norm.indexOf(needle, from)) !== -1) {
    count++;
    if (count === 1) at = i;
    from = i + 1;
  }
  if (count !== 1) return { count, from: -1, to: -1 };

  const first = points[at];
  const last = points[at + needle.length - 1];
  if (first === undefined || last === undefined) return { count: 0, from: -1, to: -1 };
  return { count: 1, from: first, to: last + 1 };
}

/** Trusts the stored offsets when the text still standing there is the text
 *  the assumption was written about, and falls back to the quote when not. */
export function resolveAnchor(doc: string, anchor: Anchor): Resolution {
  const { from, to } = anchor;
  const inRange = from >= 0 && to <= doc.length && from < to;
  if (inRange && normaliseQuote(doc.slice(from, to)) === normaliseQuote(anchor.quote)) {
    return { kind: 'exact', from, to };
  }

  const found = findQuote(doc, anchor.quote);
  if (found.count === 1) return { kind: 'quote', from: found.from, to: found.to };
  if (found.count > 1) return { kind: 'ambiguous', count: found.count };
  return { kind: 'absent' };
}
