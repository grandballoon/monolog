/* The wire contract, asserted without spending a token. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';

import {
  CheckerError,
  FALLBACK_BETA,
  MODEL,
  assessRequest,
  describeError,
  lineOf,
  numberedSource,
  parseMessage,
  type CheckInput,
} from './protocol';

const TEXT = 'function first(xs) {\n  return xs[0];\n}\n';
const INPUT: CheckInput = {
  path: 'src/first.js',
  languageId: 'javascript',
  text: TEXT,
  from: TEXT.indexOf('return'),
  to: TEXT.indexOf(';') + 1,
  claim: 'Throws on an empty array.',
};

type Block = { type: string; text: string; cache_control?: unknown };

function blocks(request: ReturnType<typeof assessRequest>): Block[] {
  return request.messages[0]!.content as unknown as Block[];
}

test('the default request uses Sonnet 5 with adaptive thinking', () => {
  const request = assessRequest(INPUT);
  assert.equal(MODEL, 'claude-sonnet-5');
  assert.equal(request.model, 'claude-sonnet-5');
  assert.deepEqual(request.thinking, { type: 'adaptive' });
  assert.equal(request.output_config?.effort, undefined);
  // The refusal fallback is documented for Opus 5, not Sonnet 5.
  assert.equal(request.fallbacks, undefined);
  assert.equal(request.betas, undefined);
});

test('Opus 5, when chosen, gets the refusal fallback', () => {
  const request = assessRequest(INPUT, { model: 'claude-opus-5' });
  assert.equal(request.model, 'claude-opus-5');
  assert.equal(request.fallbacks, 'default');
  assert.deepEqual(request.betas, [FALLBACK_BETA]);
});

test('the answer is constrained to a verdict and a note', () => {
  const format = assessRequest(INPUT).output_config?.format as unknown as {
    schema: { properties: { verdict: { enum: string[] } }; required: string[] };
  };
  assert.deepEqual(format.schema.properties.verdict.enum, [
    'wrong',
    'imprecise',
    'missing',
    'solid',
    'unverifiable',
  ]);
  assert.deepEqual(format.schema.required, ['verdict', 'note']);
});

test('the file is the cached prefix and the assumption comes after it', () => {
  const [file, question] = blocks(assessRequest(INPUT));
  assert.deepEqual(file!.cache_control, { type: 'ephemeral' });
  assert.match(file!.text, /src\/first\.js \(javascript\)/);
  assert.match(file!.text, /2 \|   return xs\[0\];/);
  assert.equal(question!.cache_control, undefined);
  assert.match(question!.text, /line 2:/);
  assert.match(question!.text, /<span>\nreturn xs\[0\];\n<\/span>/);
  assert.match(question!.text, /<assumption>\nThrows on an empty array\.\n<\/assumption>/);
});

test('two checks on one file share the cached prefix byte for byte', () => {
  const a = blocks(assessRequest(INPUT))[0];
  const b = blocks(assessRequest({ ...INPUT, from: 0, to: 8, claim: 'Declares a function.' }))[0];
  assert.deepEqual(a, b);
});

test('a span over several lines names the range', () => {
  const [, question] = blocks(assessRequest({ ...INPUT, from: 0, to: TEXT.length - 1 }));
  assert.match(question!.text, /lines 1–3:/);
});

test('a span ending on a newline does not claim the next line', () => {
  const end = TEXT.indexOf('\n') + 1;
  const [, question] = blocks(assessRequest({ ...INPUT, from: 0, to: end }));
  assert.match(question!.text, /line 1:/);
});

test('effort is sent when chosen', () => {
  assert.equal(assessRequest(INPUT, { effort: 'low' }).output_config?.effort, 'low');
});

test('Haiku gets neither thinking, effort, nor the fallback', () => {
  const request = assessRequest(INPUT, { model: 'claude-haiku-4-5', effort: 'low' });
  assert.equal(request.model, 'claude-haiku-4-5');
  assert.equal(request.thinking, undefined);
  assert.equal(request.output_config?.effort, undefined);
  assert.equal(request.fallbacks, undefined);
  assert.equal(request.betas, undefined);
});

test('an unknown model falls back to the default rather than a 404', () => {
  assert.equal(assessRequest(INPUT, { model: 'claude-nonsense' }).model, MODEL);
});

test('line numbers are padded and count CRLF like LF', () => {
  const source = numberedSource(Array.from({ length: 10 }, (_, i) => `l${i}`).join('\r\n'));
  assert.match(source, /^ 1 \| l0$/m);
  assert.match(source, /^10 \| l9$/m);
  assert.equal(lineOf('a\r\nb\r\nc', 'a\r\nb\r\n'.length), 3);
});

test('an answer is read from the text block after thinking', () => {
  const assessment = parseMessage({
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '{"verdict":"wrong","note":"`xs[0]` is `undefined`, not a throw."}' },
    ],
  });
  assert.deepEqual(assessment, { verdict: 'wrong', note: '`xs[0]` is `undefined`, not a throw.' });
});

test('a refusal, a cut-off answer, and a malformed one each say so', () => {
  const code = (body: unknown): string => {
    try {
      parseMessage(body);
      return 'none';
    } catch (e) {
      return (e as CheckerError).code;
    }
  };
  assert.equal(code({ stop_reason: 'refusal', content: [] }), 'refusal');
  assert.equal(code({ stop_reason: 'max_tokens', content: [] }), 'malformed');
  assert.equal(code({ stop_reason: 'end_turn', content: [] }), 'malformed');
  assert.equal(code({ content: [{ type: 'text', text: 'not json' }] }), 'malformed');
  assert.equal(code({ content: [{ type: 'text', text: '{"verdict":"meh","note":""}' }] }), 'malformed');
});

test('SDK errors map onto codes the UI acts on', () => {
  const headers = new Headers();
  const status = (n: number) => describeError(Anthropic.APIError.generate(n, {}, 'x', headers)).code;
  assert.equal(status(401), 'auth');
  assert.equal(status(403), 'auth');
  assert.equal(status(404), 'no_model_access');
  assert.equal(status(429), 'rate_limited');
  assert.equal(status(529), 'overloaded');
  assert.equal(status(400), 'api');
  assert.equal(describeError(new Anthropic.APIConnectionTimeoutError()).code, 'network');
  assert.equal(describeError(new Anthropic.APIConnectionError({ message: 'offline' })).code, 'network');
  assert.equal(describeError(CheckerError.notConnected()).code, 'not_connected');
});
