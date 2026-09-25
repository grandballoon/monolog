/* What an assumption looks like, decided once — with nothing `vscode` in it.
 *
 * An assumption is shown in three places: the highlight on its code, the
 * summary at the end of its last line, and its comment thread. All three read
 * their words and their colour from here, so the same state reads the same way
 * wherever the reader meets it, as Recall's one palette did for its highlight,
 * pill and breadcrumb.
 */
import type { Verdict } from '../checker/protocol';
import { isFileScoped, isStale, isUnfinished, kindOf, type Assumption } from '../store/format';
import { trim } from '../check/outcome';
import { TAG_COLORS, tagsOf, type TagColor } from '../tags/tags';

/** The reader's word for each verdict. `missing` is deliberately not a
 *  failure: an incomplete assumption is not a wrong one. */
export const VERDICT_LABELS: Record<Verdict, string> = {
  wrong: 'Incorrect',
  imprecise: 'Imprecise',
  missing: 'Incomplete',
  solid: 'Solid',
  unverifiable: "Can't tell from this file",
};

export type Status =
  /** A scratch note: the reader's own text, with nothing to check. */
  | { kind: 'scratch' }
  | { kind: 'checking' }
  /** Asked for, and never answered — the window closed mid-check. */
  | { kind: 'interrupted' }
  /** Saved without a verdict: demo mode, no key, or a failed check. */
  | { kind: 'unchecked' }
  | { kind: 'verdict'; verdict: Verdict; stale: boolean };

export function statusOf(a: Assumption, running: boolean): Status {
  if (kindOf(a) === 'scratch') return { kind: 'scratch' };
  if (running) return { kind: 'checking' };
  if (a.verdict !== null) return { kind: 'verdict', verdict: a.verdict, stale: isStale(a) };
  if (isUnfinished(a)) return { kind: 'interrupted' };
  return { kind: 'unchecked' };
}

/** A note painted in the colour of one of its tags. */
export type TagPaint = `tag${Capitalize<TagColor>}`;

/** The colour a highlight takes. Anything that is not a current verdict is
 *  neutral: colouring code before an assessment exists, or after the code it
 *  assessed has changed, would report something nothing has established. A
 *  scratch note has a colour of its own, so it is never mistaken for an
 *  assumption waiting on a check — or, while tag colours are shown, the
 *  colour of its first tag that has one. */
export type Paint = Verdict | 'pending' | 'scratch' | TagPaint;

export function tagPaint(color: TagColor): TagPaint {
  return `tag${color[0]!.toUpperCase()}${color.slice(1)}` as TagPaint;
}

export const PAINTS: readonly Paint[] = [
  'pending',
  'wrong',
  'imprecise',
  'missing',
  'solid',
  'unverifiable',
  'scratch',
  ...TAG_COLORS.map(tagPaint),
];

export function paintOf(status: Status): Paint {
  if (status.kind === 'scratch') return 'scratch';
  return status.kind === 'verdict' && !status.stale ? status.verdict : 'pending';
}

/** The colour of a tag that decides a note's paint: its first tag, in the
 *  order the note mentions them, that has a colour. Null for an assumption,
 *  for a note with no coloured tag, and when `colors` is null — tag colours
 *  are switched off. */
export function tagColorOf(a: Assumption, colors: ReadonlyMap<string, TagColor> | null): TagColor | null {
  if (colors === null || kindOf(a) !== 'scratch') return null;
  for (const tag of tagsOf(a.claim)) {
    const color = colors.get(tag);
    if (color) return color;
  }
  return null;
}

/** An entry's paint, with its tags taken into account. */
export function paintFor(a: Assumption, running: boolean, colors: ReadonlyMap<string, TagColor> | null): Paint {
  const color = tagColorOf(a, colors);
  return color === null ? paintOf(statusOf(a, running)) : tagPaint(color);
}

/** A short phrase for the state, used as the thread's heading and at the
 *  start of the line-end summary. */
export function statusLabel(status: Status): string {
  switch (status.kind) {
    case 'scratch':
      return 'Note';
    case 'checking':
      return 'Checking…';
    case 'interrupted':
      return 'Check interrupted';
    case 'unchecked':
      return 'Not checked';
    case 'verdict':
      return status.stale
        ? `${VERDICT_LABELS[status.verdict]} · code changed since`
        : VERDICT_LABELS[status.verdict];
  }
}

/** What an entry is called: a titled note by its title, a note about the
 *  whole file as one, anything else by its state. */
function headingOf(a: Assumption, running: boolean): string {
  return hoverTitle(a) ?? (isFileScoped(a) ? 'File note' : statusLabel(statusOf(a, running)));
}

/** The heading of an assumption's comment thread. */
export function threadLabel(a: Assumption, running: boolean): string {
  const label = headingOf(a, running);
  if (a.resolved) return `Resolved · ${label}`;
  if (a.unanchored) return `Code not found · ${label}`;
  return label;
}

/** What sits at the end of the assumption's last line: enough to recognise it
 *  without opening the thread, short enough not to crowd the code. */
export function summaryText(a: Assumption, running: boolean): string {
  return `${headingOf(a, running)} — ${trim(a.claim, 60)}`;
}

/** What hovering over a note's code or its summary shows: its title, or
 *  null for no hover at all. Only a titled note has one; everything else
 *  keeps the code clear of popups. Plain text. */
export function hoverTitle(a: Assumption): string | null {
  return kindOf(a) === 'scratch' && a.title ? a.title : null;
}

/** What the thread says below the reader's assumption, or an empty string
 *  when there is nothing to say — always, for a scratch note. Markdown. */
export function noteText(a: Assumption, running: boolean): string {
  const status = statusOf(a, running);
  switch (status.kind) {
    case 'scratch':
      return '';
    case 'checking':
      return '_Reading the code…_';
    case 'interrupted':
      return 'This check never came back. Your assumption is saved; use **Check Again** to ask for it.';
    case 'unchecked':
      return a.note;
    case 'verdict':
      return status.stale
        ? `_The code has changed since this was checked; use **Check Again** to see whether it still holds._\n\n${a.note}`
        : a.note;
  }
}

/** Whether the highlight and line-end summary are drawn at all. A resolved
 *  assumption keeps its record and thread, but comes off the code. A note
 *  about the whole file has no code to be drawn on. */
export function isDrawn(a: Assumption): boolean {
  return !a.resolved && !a.unanchored && !isFileScoped(a);
}

/** What the Explorer says about a file with notes about it as a whole: the
 *  notes' titles, or the start of each untitled one's text. Null when there
 *  is nothing to say. */
export function fileNotesTooltip(entries: readonly Assumption[]): string | null {
  const notes = entries.filter((a) => isFileScoped(a) && !a.resolved);
  if (notes.length === 0) return null;
  return notes.map((a) => a.title ?? trim(a.claim, 80)).join('\n');
}
