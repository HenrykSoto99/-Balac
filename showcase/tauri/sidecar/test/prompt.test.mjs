import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The system prompt is template literals in sidekick.mjs: an expression wrapped in a string (${"${x}"}) would reach
// the model as raw code instead of its value.
const side = readFileSync(fileURLToPath(new URL('../sidekick.mjs', import.meta.url)), 'utf8');
const quoted = side.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\$\{\s*["'`][^"'`]*\$\{/.test(l));
assert.deepEqual(quoted.map(([n]) => n), [], 'a ${…} inside a quoted string in a template literal is sent as text');
// Pointing is the draw tool now: the prompt never names the old tool.
assert.ok(!/point_at/.test(side), 'no point_at left in the prompt');
assert.match(side, /with draw/, 'the prompt says when to draw');
// Saving a reminder shows the reminders card by itself: the prompt and the draw tool say not to draw it again.
const tools = readFileSync(fileURLToPath(new URL('../tools.mjs', import.meta.url)), 'utf8');
assert.match(side, /remember_commitment[^\n]*shows their reminders list on screen by itself, so don't also draw a list or note/, 'the memory line says saved items show by themselves');
assert.match(tools, /remember_commitment or update_commitment already show on their reminders list by themselves: never draw a list or note of them/, 'the draw tool says saved items are not drawn again');
// Regression: every web search opened the card, because web answers always came as points plus sources. A quick fact
// is just said; the card is only for answers that break down into points.
assert.match(side, /An answer from the web is said like any other: a quick fact[^\n]*no points and no sources\. Only when the answer is genuinely a list/, 'web answers are spoken unless they are a list');
const host = readFileSync(fileURLToPath(new URL('../../../roamies/host.js', import.meta.url)), 'utf8');
const webCase = host.slice(host.indexOf("if (e.anim.tool === 'web')"), host.indexOf('jobs.push', host.indexOf("if (e.anim.tool === 'web')")));
assert.ok(webCase && !/panel\(\)\?\.open/.test(webCase), 'a web lookup does not open the card by itself');
console.log('prompt tests: passed');
