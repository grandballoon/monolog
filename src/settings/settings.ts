/* What the reader can change, and what it means — with nothing `vscode` in it.
 *
 * The values come from VS Code's configuration, which is a JSON file the
 * reader can edit by hand, so nothing here trusts them to be the right shape.
 * An unknown model would fail every check with a 404 that reads like a key
 * problem, which is a bad way to find out.
 *
 * The API key is not a setting. It lives in VS Code's SecretStorage, which is
 * the OS keychain — the constraint Recall's desktop app held and its Obsidian
 * port had to give up, restored.
 */
import { EFFORTS, MODEL, MODELS, type Effort } from '../checker/protocol';

export interface Settings {
  model: string;
  /** Null sends no effort at all, which is the API's own default. */
  effort: Effort | null;
  demoMode: boolean;
  inlineSummary: boolean;
}

export function normaliseSettings(raw: Partial<Record<keyof Settings, unknown>>): Settings {
  const model = MODELS.some((m) => m.id === raw.model) ? (raw.model as string) : MODEL;
  const effort = (EFFORTS as readonly unknown[]).includes(raw.effort) ? (raw.effort as Effort) : null;
  return {
    model,
    effort,
    demoMode: raw.demoMode === true,
    inlineSummary: raw.inlineSummary !== false,
  };
}
