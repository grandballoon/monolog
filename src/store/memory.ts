/* A map for a disk, for the headless tests of everything that persists. */
import type { StoreAdapter } from './store';

export function memoryAdapter(): StoreAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, data) {
      files.set(path, data);
    },
    async remove(path) {
      files.delete(path);
    },
    async list(folder) {
      return [...files.keys()]
        .filter((p) => p.startsWith(`${folder}/`))
        .map((p) => p.slice(folder.length + 1));
    },
  };
}
