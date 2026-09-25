/* A file with notes about it as a whole, marked in the Explorer.
 *
 * A span's note is seen on its code; a note about the whole file has no code,
 * and sits at the top of the file where it is seen only once the file is
 * open. So the Explorer marks the file itself: a ✎ badge, the notes' titles
 * on hover, and — while tag colours are shown — the file's name in the colour
 * of the first of its notes with a coloured tag.
 */
import * as vscode from 'vscode';

import { isFileScoped, type Assumption } from '../store/format';
import type { TagColor } from '../tags/tags';
import { fileNotesTooltip, tagColorOf, tagPaint } from './present';

const BADGE = '✎';

export class FileNotes implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;

  constructor(
    private readonly entries: (uri: string) => readonly Assumption[],
    private readonly colors: (uri: string) => ReadonlyMap<string, TagColor> | null,
  ) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const key = uri.toString();
    const entries = this.entries(key);
    const tooltip = fileNotesTooltip(entries);
    if (tooltip === null) return undefined;

    const colors = this.colors(key);
    let color: TagColor | null = null;
    for (const a of entries) {
      if (!isFileScoped(a) || a.resolved) continue;
      color = tagColorOf(a, colors);
      if (color !== null) break;
    }
    return new vscode.FileDecoration(
      BADGE,
      tooltip,
      color === null ? undefined : new vscode.ThemeColor(`monolog.${tagPaint(color)}Border`),
    );
  }

  /** One file's mark may have changed, or, with no URI, any file's. */
  refresh(uri?: string): void {
    this.changed.fire(uri === undefined ? undefined : vscode.Uri.parse(uri));
  }

  dispose(): void {
    this.changed.dispose();
  }
}
