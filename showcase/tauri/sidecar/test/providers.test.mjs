// What the setup guide offers to connect. Run: npm test
import assert from 'node:assert/strict';
import { AUTH_PROVIDERS, apiKeyStorageKeys, getAuthStorageKeys, getModelsForProvider, storageKeyProvider } from '@kenkaiiii/gg-core';
import { KEY_LINKS, keyCards, keyKinds, signInCards } from '../providers.mjs';
import { SAFE, checkLink } from '../safety.mjs';

const cards = signInCards(['anthropic', 'openai'], (id) => id === 'openai');
assert.deepEqual(cards.map((c) => c.name), ['Claude', 'ChatGPT'], 'Kimi, Grok and Google sign-ins were retired in gg-core 5.95');
assert.deepEqual(cards.filter((c) => c.connected).map((c) => c.id), ['openai']);

// Regression: only the providers in a <select> were offered, and it showed one name until opened.
const keys = keyCards(AUTH_PROVIDERS, (id) => id === 'deepseek');
assert.deepEqual(keys.map((k) => k.id), ['anthropic', 'openai', 'gemini', 'xai', 'kimi-code', 'moonshot', 'glm', 'minimax', 'xiaomi', 'xiaomi-credits', 'deepseek', 'sakana', 'openrouter', 'huggingface'],
  'every kind of API key, Anthropic and OpenAI included; Kimi and Xiaomi have a plan key and a pay-per-token key');
assert.equal(keys.find((k) => k.id === 'kimi-code').name, 'Kimi Code', 'short names, so each card is one line');
assert.deepEqual(keys.filter((k) => k.connected).map((k) => k.id), ['deepseek']);
for (const k of keys) {
  assert.ok(k.link, `${k.id} has a "Get a key" link`);
  assert.equal(new URL(k.link).protocol, 'https:');
  assert.equal(checkLink(k.link).level, SAFE, `${k.id}'s link passes open_link`);
  assert.ok(k.name.length <= 13, `${k.id}'s name fits a one-line card`);
}
assert.deepEqual(Object.keys(KEY_LINKS).sort(), keys.map((k) => k.id).sort(), 'no links for providers that are gone');

// Regression: a Moonshot key was saved as a Kimi Code plan key (the first kind) and never worked.
for (const p of AUTH_PROVIDERS.filter((x) => x.methods.includes('apikey'))) {
  const kinds = keyKinds(p).map(([id]) => id);
  for (const id of kinds) assert.equal(storageKeyProvider(id), p.value, `${id} saves under ${p.value}`);
  if (kinds.length > 1) assert.deepEqual(kinds.sort(), apiKeyStorageKeys(p.value).sort(), `${p.value}: a card for each kind of key`);
  // Every model can be reached by a sign-in or a key the guide offers.
  for (const m of getModelsForProvider(p.value)) {
    assert.ok(getAuthStorageKeys(p.value, m.id).some((k) => k === p.value || apiKeyStorageKeys(p.value).includes(k)), `${m.id} has a way in`);
  }
}
console.log('providers ok');
