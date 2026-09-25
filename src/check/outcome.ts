/* What an assumption says when the answer is not an assessment.
 *
 * Two of the three outcomes of asking for a check are not verdicts, and both
 * are the same shape as one: a note with no label. Keeping them here — pure,
 * and away from the transport — is what lets the thread render one thing
 * regardless of how the check went.
 *
 * The rule both observe, carried over from Recall: a check that did not happen
 * leaves the verdict null. Labelling the code when nothing read it would be a
 * lie about what happened, and the highlight stays neutral to say exactly that.
 */
import { CheckerError, type Verdict } from '../checker/protocol';

export interface Outcome {
  verdict: Verdict | null;
  note: string;
}

/** Why an assumption carries placeholder text instead of an assessment. The
 *  two read differently because they are different: one is a thing to fix,
 *  the other is a choice the reader made. */
export type DemoReason = 'no-key' | 'chosen';

export function demoOutcome(reason: DemoReason): Outcome {
  return {
    verdict: null,
    note:
      reason === 'chosen'
        ? 'Demo mode is on, so this assumption was saved but not checked. ' +
          'Turn off `monolog.demoMode` and check it again to have it read.'
        : 'No checker is connected, so this assumption was saved but not checked. ' +
          'Run **Monolog: Set Anthropic API Key**, then check it again.',
  };
}

/** The check was asked for and did not come back.
 *
 *  A missing key is not really a failure of this assumption, so it reads as
 *  demo mode — the same note the reader would have got before trying.
 *  Everything else says what went wrong and that the assumption is safe. */
export function failureOutcome(error: unknown): Outcome {
  if (error instanceof CheckerError && error.code === 'not_connected') {
    return demoOutcome('no-key');
  }
  const message =
    error instanceof Error && error.message ? error.message : 'The check could not be completed.';
  return { verdict: null, note: `${message} Your assumption is saved.` };
}

/** Trims to a length that fits at the end of a line of code. */
export function trim(text: string, max: number): string {
  const clean = (text ?? '').trim().replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
