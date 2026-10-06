import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, ProviderError } from '../lib/providers.mjs';

const provider = { protocol: 'openai', baseURL: 'https://example.test/v1', key: 'test-key', model: 'test-model', label: 'Test provider' };
const request = { state: 'Choose the requested button.', questions: { nextAction: { type: 'choice', instructions: 'Choose an available action.', criteria: { click_0: 'Open report', done: 'Task finished' } } } };

test('model access denied by Gateway explains the account requirement', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { type: 'no_providers_available', message: 'Free tier users do not have access to this model.' } }), { status: 403 });
  await assert.rejects(evaluate(provider, request, { fetchImpl }), (error) => error instanceof ProviderError && error.status === 403 && /requires paid Gateway credits/.test(error.message));
});

test('rate limits remain distinguishable from model or credential errors', async () => {
  await assert.rejects(evaluate(provider, request, { fetchImpl: async () => new Response('{}', { status: 429 }) }), (error) => error.status === 429 && /rate limit or quota/.test(error.message));
});

test('a model cannot introduce an action outside the supplied DOM candidates', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"nextAction":"click_999"}' } }] }));
  await assert.rejects(evaluate(provider, request, { fetchImpl }), /No browser action was selected/);
});
