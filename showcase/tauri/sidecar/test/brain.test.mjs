// Side calls: which model folds and learns, the retry, the transcript they read, and what's kept of their reply.
import assert from 'node:assert/strict';
import { foldInput, foldPrompt, memoryInput, memoryPrompt, oneShot, parseBrain, sideThinking, summaryModelFor, transcript } from '../brain.mjs';

// The summary model is gg-core's cheaper pick, unless the current model is cheaper still.
assert.equal(summaryModelFor('anthropic', 'claude-opus-5-5'), 'claude-sonnet-5-5', 'Opus folds on Sonnet');
assert.equal(summaryModelFor('anthropic', 'claude-haiku-5-5'), 'claude-haiku-5-5', 'Haiku is already cheaper than Sonnet');

// Side calls think at the model's lowest level, never above the chat's. Regression: Gemini lists only "high",
// so folds and memory passes ran at high while the chat ran at low.
assert.equal(sideThinking('gemini', 'gemini-3.8-flash', 'low'), 'low', 'capped at the chat level');
assert.equal(sideThinking('anthropic', 'claude-sonnet-5-5', 'high'), 'low', 'the lowest level when the chat thinks harder');
assert.equal(sideThinking('anthropic', 'claude-sonnet-5-5', null), undefined, 'thinking off in the chat: off here too');
assert.equal(sideThinking('huggingface', 'deepseek-ai/DeepSeek-V4.1-Flash', 'low'), undefined, 'a model that cannot think gets none');

// Summary model first; if that fails, once more on the current model.
{
  const tried = [];
  const run = async (o) => { tried.push(o.model); if (o.model === 'claude-sonnet-5-5') throw new Error('not on this plan'); return '{"facts":[]}'; };
  const r = await oneShot({ provider: 'anthropic', model: 'claude-opus-5-5', system: 's', text: 't', run });
  assert.deepEqual(tried, ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.equal(r.model, 'claude-opus-5-5');
  await assert.rejects(oneShot({ provider: 'anthropic', model: 'claude-haiku-5-5', system: 's', text: 't', run: async () => { throw new Error('down'); } }), /down/, 'no second try on the same model');
}

// The reply: JSON (fenced or not), facts redacted and checked, replaces only for ids that exist.
{
  const reply = '```json\n{"summary": "Ken asked to tidy the Downloads folder and it was done.", "facts": [' +
    '{"text": "Ken edits videos in Final Cut Pro"}, {"text": "Ken now lives in Lisbon", "replaces": "f111111"}, {"text": "Ken likes tea", "replaces": "f999999"},' +
    '{"text": "Ken\'s API key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"}, {"text": "Ken\'s password is hunter2"}, {"text": "Card 4111 1111 1111 1111"}, {"text": "x"}, "Ken has a dog called Rex"]}\n```';
  const out = parseBrain(reply, { knownIds: ['f111111'], wantSummary: true });
  assert.match(out.summary, /Downloads/);
  assert.deepEqual(out.facts, [
    { text: 'Ken edits videos in Final Cut Pro' },
    { text: 'Ken now lives in Lisbon', replaces: 'f111111' },
    { text: 'Ken likes tea' }, // an id that doesn't exist replaces nothing
    { text: 'Ken has a dog called Rex' },
  ], 'secrets, card numbers and scraps are dropped');
  assert.deepEqual(parseBrain('Sure! {"facts": []}').facts, [], 'nothing new');
  assert.throws(() => parseBrain('no json here'), /no JSON/);
  assert.throws(() => parseBrain('{"facts": []}', { wantSummary: true }), /no summary/, 'a fold needs its summary');
  assert.ok(!/sk-ant/.test(parseBrain('{"summary": "They pasted sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 by mistake and were told to rotate it."}', { wantSummary: true }).summary), 'the summary is redacted too');
}

// What the side calls read: words and tool names, results cut short, notes stripped.
{
  const msgs = [
    { role: 'user', content: '[note] hidden\n\nKen said: I make videos' },
    { role: 'assistant', content: [{ type: 'text', text: 'Nice.' }, { type: 'tool_call', id: 'a', name: 'read_file', args: { path: '/x' } }] },
    { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'a', content: 'r'.repeat(1000) }] },
    { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
  ];
  const t = transcript(msgs, 'Ken', (x) => x.replace(/^\[note\][\s\S]*?said: /, ''));
  assert.match(t, /^Ken: I make videos\nAssistant: Nice\. \[used read_file \{"path":"\/x"\}\]\n\[tool result\] r{300}…\nKen: what is this \[image\]$/);
  assert.ok(!t.includes('AAAA'), 'no image data');
  const facts = [{ id: 'f1', text: 'Ken makes videos' }];
  assert.match(foldInput({ facts, summary: 'Earlier.', turns: t, name: 'Ken' }), /- f1: Ken makes videos[\s\S]*Earlier summary:\nEarlier\.[\s\S]*Turns to fold/);
  assert.match(memoryInput({ facts: [], turns: t }), /\(none yet\)/);
  for (const p of [foldPrompt('Ken'), memoryPrompt('Ken')]) assert.match(p, /JSON[\s\S]*Never secrets[\s\S]*replaces/, 'both prompts carry the fact rules');
}
console.log('brain tests: passed');
