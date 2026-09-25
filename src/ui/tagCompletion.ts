/* Tags offered while typing `#` in a comment box.
 *
 * VS Code gives each comment box a document of its own, under the `comment`
 * scheme, and runs completion providers in it like in any other. So the tags
 * already in use are offered as the reader types one, which keeps a folder's
 * tags from drifting into near-duplicates (`#perf`, `#performance`).
 */
import * as vscode from 'vscode';

import { tagBeingTyped } from '../tags/tags';

/** `tags` gives the tags to offer, at the moment they are asked for. */
export function tagCompletions(tags: () => string[]): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(doc, position) {
      const before = doc.lineAt(position.line).text.slice(0, position.character);
      const typed = tagBeingTyped(before);
      if (typed === null) return undefined;
      const range = new vscode.Range(position.translate(0, -typed.length), position);
      return tags().map((tag) => {
        const item = new vscode.CompletionItem(`#${tag}`, vscode.CompletionItemKind.Keyword);
        item.insertText = tag;
        item.filterText = tag;
        item.range = range;
        return item;
      });
    },
  };
}
