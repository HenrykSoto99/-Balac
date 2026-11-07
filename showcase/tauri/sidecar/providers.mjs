// What the setup guide offers to connect: sign-in cards, and a card per API-key provider with where to get a key.
// Gemini is hidden in gg-core (not in AUTH_PROVIDERS, never signed in), so it isn't offered.

// Checked by hand: each opens the provider's own key page (or its console, where keys are made).
export const KEY_LINKS = {
  anthropic: 'https://platform.claude.com/settings/keys', xai: 'https://console.x.ai/', moonshot: 'https://platform.kimi.ai/console/api-keys',
  glm: 'https://z.ai/manage-apikey/apikey-list', minimax: 'https://platform.minimax.io/console/keys', xiaomi: 'https://platform.xiaomimimo.com/',
  deepseek: 'https://platform.deepseek.com/api_keys', sakana: 'https://console.sakana.ai/', openrouter: 'https://openrouter.ai/settings/keys',
  huggingface: 'https://huggingface.co/settings/tokens',
};
const SIGN_IN_NAMES = { anthropic: ['Claude', 'Anthropic'], openai: ['ChatGPT', 'OpenAI'], xai: ['Grok', 'xAI'], moonshot: ['Kimi', 'Moonshot'] };

/** Sign-in cards, in `ids` order; `on(id)`: signed in with that account (not just a key). */
export const signInCards = (ids, on, labels = {}) =>
  ids.filter((id) => id !== 'gemini').map((id) => ({ id, name: SIGN_IN_NAMES[id]?.[0] ?? labels[id] ?? id, company: SIGN_IN_NAMES[id]?.[1] ?? '', connected: !!on(id) }));

/** One card per provider that takes an API key; `on(id)`: a key is saved for it. */
export const keyCards = (authProviders, on) =>
  authProviders.filter((p) => p.methods?.includes('apikey') && p.value !== 'gemini')
    .map((p) => ({ id: p.value, name: p.apiKeyLabel ?? p.label, connected: !!on(p.value), link: KEY_LINKS[p.value] ?? null }));
