/* #tags: what a note is about, written into the note itself.
 *
 * A tag is part of the note's text rather than a field beside it, so there
 * is one thing to edit and nothing to keep in step: the tags a note has are
 * the tags its text mentions. The metadata file writes them out beside the
 * text as well, so a tool reading it need not know this grammar.
 *
 * A tag is `#` and a letter, then letters, digits, `_`, `-` or `/`, and is
 * compared lowercased. It must start a word, so `page#anchor`, `&#39;` and
 * `#123` are not tags.
 */

/** The colours a tag can take: VS Code's own palette for extensions, the
 *  `charts.*` colours plus the terminal's cyan and magenta. Each has a
 *  contributed theme colour (`monolog.tagRedBackground`, `…Border`) whose
 *  default is the editor's, so a theme restyles it and so can the reader. */
export const TAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'cyan', 'magenta'] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export function isTagColor(value: unknown): value is TagColor {
  return (TAG_COLORS as readonly unknown[]).includes(value);
}

const TAG = /(?<![\p{L}\p{N}_#&/])#(\p{L}[\p{L}\p{N}_/-]*)/gu;
const WHOLE_TAG = /^\p{L}[\p{L}\p{N}_/-]*$/u;

/** Trailing `-` and `/` are punctuation after the tag, not part of it. */
function clean(body: string): string {
  return body.replace(/[-/]+$/u, '').toLowerCase();
}

/** The tags in `text`, lowercased, each once, in the order they first appear. */
export function tagsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(TAG)) seen.add(clean(match[1]!));
  return [...seen];
}

/** A tag as the reader typed it into a prompt — with or without its `#` —
 *  in the form it is stored, or null if it is not a tag. */
export function normaliseTag(input: string): string | null {
  const body = clean(input.trim().replace(/^#/u, ''));
  return WHOLE_TAG.test(body) ? body : null;
}

/** The partial tag being typed just before the cursor, for completion: the
 *  text after its `#`, or null if the cursor is not in a tag. */
export function tagBeingTyped(before: string): string | null {
  const match = /(?<![\p{L}\p{N}_#&/])#([\p{L}\p{N}_/-]*)$/u.exec(before);
  return match ? match[1]! : null;
}
