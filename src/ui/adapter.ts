/* The store's disk: `vscode.workspace.fs`, rooted in the extension's private
 * storage for this workspace.
 *
 * Writes go to a temporary file first and are renamed into place, so a window
 * closed mid-write leaves the previous record rather than half of a new one.
 * A half-written record would read as unreadable and switch that file's
 * saving off, which is safe but needless.
 */
import * as vscode from 'vscode';

import type { StoreAdapter } from '../store/store';

function isNotFound(e: unknown): boolean {
  return e instanceof vscode.FileSystemError && e.code === 'FileNotFound';
}

export function workspaceAdapter(root: vscode.Uri): StoreAdapter {
  const fs = vscode.workspace.fs;
  const at = (path: string): vscode.Uri => vscode.Uri.joinPath(root, ...path.split('/'));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    async read(path) {
      try {
        return decoder.decode(await fs.readFile(at(path)));
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async write(path, data) {
      const target = at(path);
      const temporary = at(`${path}.tmp`);
      await fs.createDirectory(vscode.Uri.joinPath(target, '..'));
      await fs.writeFile(temporary, encoder.encode(data));
      await fs.rename(temporary, target, { overwrite: true });
    },
    async remove(path) {
      try {
        await fs.delete(at(path));
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
    async list(folder) {
      try {
        const entries = await fs.readDirectory(at(folder));
        return entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);
      } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
      }
    },
  };
}
