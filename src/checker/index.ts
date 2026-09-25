/* The only module that talks to the Anthropic API.
 *
 * Recall's Obsidian port hand-built the HTTP because a plugin runs in the
 * renderer, where CORS blocks api.anthropic.com. A VS Code extension runs in
 * the extension host, which is Node, so the official SDK works as it is and
 * brings its typed errors, retries and timeouts along. `protocol.ts` still
 * owns the request shape and the reading of the answer; this file only sends.
 *
 * Demo mode and the blank verdict on a failed check are the caller's business.
 * This module returns an assessment or throws a `CheckerError` saying why not.
 */
import Anthropic from '@anthropic-ai/sdk';

import {
  CheckerError,
  MODEL,
  assessRequest,
  describeError,
  parseMessage,
  type Assessment,
  type CheckInput,
  type CheckOptions,
} from './protocol';

/** Adaptive thinking over a long file can take a while; this is a ceiling,
 *  not a target. The SDK retries a timed-out request, so the worst case is a
 *  small multiple of it. */
const TIMEOUT_MS = 180_000;

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, timeout: TIMEOUT_MS });
}

/** Confirms a key both authenticates and can reach the chosen model. Costs no
 *  tokens, and turns "it silently never works" into a sentence at the moment
 *  the key is pasted. */
export async function verifyKey(apiKey: string, model: string = MODEL): Promise<void> {
  if (!apiKey) throw CheckerError.notConnected();
  try {
    await client(apiKey).models.retrieve(model);
  } catch (e) {
    throw describeError(e);
  }
}

export async function assess(
  apiKey: string,
  input: CheckInput,
  options: CheckOptions = {},
): Promise<Assessment> {
  if (!apiKey) throw CheckerError.notConnected();

  let message: unknown;
  try {
    message = await client(apiKey).beta.messages.create(assessRequest(input, options));
  } catch (e) {
    throw describeError(e);
  }
  return parseMessage(message);
}

export * from './protocol';
