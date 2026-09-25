/* The contract for one assumption check — and nothing else.
 *
 * Ported from Recall's checker (`src-tauri/src/claude.rs`, then
 * `obs_port/src/checker/protocol.ts`), with the question turned around.
 * Recall asks whether a span of the reader's own writing is right. Monolog
 * asks whether the reader's assumption about a span of code is right: the
 * code is the ground truth, and the reader's words are what is on trial.
 *
 * Everything here is pure, so the request shape and every failure path can be
 * asserted without spending a token or starting VS Code. The transport lives
 * next door in `index.ts`.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** Server-side refusal fallback: if a safety classifier declines the request,
 *  the API re-runs it on a model chosen by the refusal's category, inside the
 *  same call, instead of handing back an empty answer. Code about security
 *  tooling is exactly the material a reader might be studying. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The default. Opus 5 is offered as the more careful reader for anyone who
 *  would rather pay for it: a confidently wrong "solid" is worse than no check
 *  at all, because the reader stops doubting the assumption and builds on it. */
export const MODEL = 'claude-sonnet-5';

export interface ModelInfo {
  id: string;
  /** Whether the model takes `thinking: {type: 'adaptive'}` and an effort
   *  level. Haiku 4.5 does neither. */
  adaptive: boolean;
  /** Whether the server-side refusal fallback is documented for it. */
  fallbacks: boolean;
}

/** What settings offers, in the order it lists them. To spend less, lower
 *  the effort before choosing a smaller model: it keeps the model. */
export const MODELS: readonly ModelInfo[] = [
  { id: 'claude-sonnet-5', adaptive: true, fallbacks: false },
  { id: 'claude-opus-5', adaptive: true, fallbacks: true },
  { id: 'claude-haiku-4-5', adaptive: false, fallbacks: false },
];

export const EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface CheckOptions {
  model?: string;
  /** Left off entirely by default, which is the API's own default effort. */
  effort?: Effort | null;
}

/** Ample for adaptive thinking plus a three-sentence answer, and within what a
 *  non-streaming request can return before an HTTP timeout. */
const MAX_TOKENS = 16_000;

export const VERDICTS = ['wrong', 'imprecise', 'missing', 'solid', 'unverifiable'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Assessment {
  verdict: Verdict;
  note: string;
}

/** What the checker is shown. */
export interface CheckInput {
  /** Workspace-relative where possible; it is context, not an address. */
  path: string;
  languageId: string;
  /** The whole file as it stands now. */
  text: string;
  /** Zero-based offsets of the span into `text`. */
  from: number;
  to: number;
  /** What the reader assumes about that span. */
  claim: string;
}

const SYSTEM_PROMPT = `You are a careful senior engineer helping someone test their understanding of code they are reading. They selected a span of a source file and wrote down an assumption about it: what it does, why it is there, what it guarantees, or how it behaves at the edges.

Assess ONLY that assumption, against the code. Read the rest of the file for context, but do not review the code itself or comment on its quality unless that is what the assumption is about.

Choose exactly one verdict:
- "wrong": the code contradicts the assumption.
- "imprecise": broadly right, but vague or misleading in a way that matters — for example, true only under a condition the assumption does not mention.
- "missing": right as far as it goes, but it leaves out something that carries the meaning — an edge case, a side effect, an error path, a second caller-visible behaviour.
- "solid": the code bears the assumption out, precisely enough.
- "unverifiable": whether it holds depends on code this file does not contain (callers, imported modules, configuration, runtime state), so this file alone cannot settle it. Use this rather than guessing; do not use it when the file does settle the question.

Then write a note of one to three sentences. Point at the specific identifiers or line numbers that decide it. If the verdict is wrong or imprecise, say what the code actually does. If it is missing, name what a complete assumption would add. If it is solid, confirm it crisply and add one detail worth knowing. If it is unverifiable, say what you would need to see, and what this file does suggest. Use backticks for code. Never give generic advice.`;

/** A failure the UI can react to differently depending on `code`. */
export type CheckerErrorCode =
  | 'not_connected'
  | 'network'
  | 'auth'
  | 'no_model_access'
  | 'rate_limited'
  | 'overloaded'
  | 'api'
  | 'malformed'
  | 'refusal';

export class CheckerError extends Error {
  readonly code: CheckerErrorCode;

  constructor(code: CheckerErrorCode, message: string) {
    super(message);
    this.name = 'CheckerError';
    this.code = code;
  }

  static notConnected(): CheckerError {
    return new CheckerError(
      'not_connected',
      'Claude is not connected yet. Run "Monolog: Set Anthropic API Key".',
    );
  }
}

export function modelInfo(id: string | undefined): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS.find((m) => m.id === MODEL)!;
}

/** The file with a line number in front of every line, so the note can say
 *  "line 42" and mean the line the reader sees as 42. */
export function numberedSource(text: string): string {
  const lines = text.split(/\r?\n/);
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`).join('\n');
}

/** One-based line of an offset, counting the same line breaks as
 *  `numberedSource`. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(Math.max(offset, 0), text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The Messages API request for one check.
 *
 *  Split out from the call so the wire shape can be asserted in tests without
 *  spending a token. */
export function assessRequest(
  input: CheckInput,
  options: CheckOptions = {},
): MessageCreateParamsNonStreaming {
  const model = modelInfo(options.model);
  const effort = model.adaptive ? (options.effort ?? null) : null;
  const span = input.text.slice(input.from, input.to);
  const firstLine = lineOf(input.text, input.from);
  // A span ending on a newline has not reached into the next line.
  const lastLine = lineOf(input.text, Math.max(input.from, input.to - 1));
  const lines = firstLine === lastLine ? `line ${firstLine}` : `lines ${firstLine}–${lastLine}`;

  return {
    model: model.id,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    ...(model.adaptive ? { thinking: { type: 'adaptive' as const } } : {}),
    ...(model.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    output_config: {
      ...(effort ? { effort } : {}),
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: [...VERDICTS] },
            note: { type: 'string' },
          },
          required: ['verdict', 'note'],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `The file, ${input.path} (${input.languageId}), with line numbers:\n\n` +
              `<file>\n${numberedSource(input.text)}\n</file>`,
            // Checking several assumptions against one unedited file replays
            // this prefix; the breakpoint lets those checks read it from cache.
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text:
              `The selected span, ${lines}:\n\n<span>\n${span}\n</span>\n\n` +
              `Their assumption about it:\n\n<assumption>\n${input.claim}\n</assumption>`,
          },
        ],
      },
    ],
  };
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

/** Turns a Messages API response into an assessment, or says why not.
 *
 *  Thinking blocks (and, on a rescued refusal, a fallback block) precede the
 *  answer, so the text block has to be picked out rather than indexed. */
export function parseMessage(body: unknown): Assessment {
  const message = (body ?? {}) as { content?: unknown; stop_reason?: unknown };

  if (message.stop_reason === 'refusal') {
    throw new CheckerError('refusal', 'Claude declined to assess this code.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new CheckerError('malformed', "Claude's answer was cut off before it finished.");
  }

  const blocks: ContentBlock[] = Array.isArray(message.content) ? message.content : [];
  const text = blocks.find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
  if (typeof text !== 'string') {
    throw new CheckerError('malformed', 'Claude returned no answer.');
  }

  // The request constrains the output to the schema above, so anything
  // unparseable here is a genuine surprise rather than a formatting slip.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CheckerError(
      'malformed',
      `Claude's answer did not match the expected shape: ${(e as Error).message}`,
    );
  }

  const answer = (parsed ?? {}) as { verdict?: unknown; note?: unknown };
  if (!isVerdict(answer.verdict) || typeof answer.note !== 'string') {
    throw new CheckerError(
      'malformed',
      "Claude's answer did not match the expected shape: missing verdict or note",
    );
  }

  return { verdict: answer.verdict, note: answer.note };
}

/** Maps whatever the SDK threw onto a code the UI can act on.
 *
 *  Most specific first: a timeout is a connection error, and every status
 *  error is an `APIError`. */
export function describeError(e: unknown): CheckerError {
  if (e instanceof CheckerError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new CheckerError('network', 'Claude took too long to answer. Check it again.');
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new CheckerError('network', `Could not reach Claude: ${e.message}`);
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new CheckerError(
      'auth',
      'That API key was rejected. Run "Monolog: Set Anthropic API Key" to replace it.',
    );
  }
  if (e instanceof Anthropic.NotFoundError) {
    return new CheckerError('no_model_access', 'The key works, but it cannot reach that model.');
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new CheckerError('rate_limited', 'Rate limited by the API. Wait a moment and check again.');
  }
  if (e instanceof Anthropic.InternalServerError) {
    return new CheckerError('overloaded', 'The API is busy right now. Check again in a moment.');
  }
  if (e instanceof Anthropic.APIError) {
    return new CheckerError('api', `The API returned ${e.status ?? 'an error'}: ${e.message}`);
  }
  return new CheckerError('api', (e as Error)?.message || 'The check could not be completed.');
}
