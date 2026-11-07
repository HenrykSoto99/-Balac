// What the setup guide offers to connect. Run: npm test
import assert from 'node:assert/strict';
import { AUTH_PROVIDERS } from '@kenkaiiii/gg-core';
import { KEY_LINKS, keyCards, signInCards } from '../providers.mjs';
import { SAFE, checkLink } from '../safety.mjs';

const cards = signInCards(['anthropic', 'openai', 'gemini', 'moonshot', 'xai'], (id) => id === 'openai');
assert.deepEqual(cards.map((c) => c.name), ['Claude', 'ChatGPT', 'Kimi', 'Grok'], 'Gemini is hidden in gg-core, so no card');
assert.deepEqual(cards.filter((c) => c.connected).map((c) => c.id), ['openai']);

// Regression: only the providers in a <select> were offered, and it showed one name until opened.
const keys = keyCards(AUTH_PROVIDERS, (id) => id === 'deepseek');
assert.deepEqual(keys.map((k) => k.id), ['anthropic', 'xai', 'moonshot', 'glm', 'minimax', 'xiaomi', 'deepseek', 'sakana', 'openrouter', 'huggingface'], 'every API-key provider, Anthropic included');
assert.equal(keys.find((k) => k.id === 'xiaomi').name, 'Xiaomi MiMo', 'short names, so each card is one line');
assert.deepEqual(keys.filter((k) => k.connected).map((k) => k.id), ['deepseek']);
for (const k of keys) {
  assert.ok(k.link, `${k.id} has a "Get a key" link`);
  assert.equal(new URL(k.link).protocol, 'https:');
  assert.equal(checkLink(k.link).level, SAFE, `${k.id}'s link passes open_link`);
}
assert.deepEqual(Object.keys(KEY_LINKS).sort(), keys.map((k) => k.id).sort(), 'no links for providers that are gone');
console.log('providers ok');
