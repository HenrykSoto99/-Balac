// The macOS tools against a fake hands helper: act_in_app drops read-only steps, screenshots use the helper's own
// resize, and an app that isn't installed gives a plain answer. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') { console.log('hands tests: skipped (macOS only)'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-hands-test-'));
const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const swap = ${JSON.stringify(path.join(dir, 'front.json'))};
const win = fs.existsSync(swap) ? JSON.parse(fs.readFileSync(swap, 'utf8')) : { id: 7, app: 'TextEdit', title: 'notes.txt', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win };
if (a[0] === 'act') { const p = JSON.parse(a[1]); o = p.app === 'NoSuchAppRoamiesTest' ? { ok: false, error: 'No matching window is open.' } : { ok: true, done: p.steps.map((s) => s.do), window: win }; }
if (a[0] === 'find-text') o = { ok: true, matches: [{ text: a[2], match: 'exact', role: 'button', bounds: [100, 100, 80, 24], window: win }] };
if (a[0] === 'front') o = { ok: true, app: 'TextEdit', title: 'notes.txt' };
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], window: win, pixels: [800, 600] }; }
console.log(JSON.stringify(o));
`, { mode: 0o755 });
process.env.ROAMIES_HANDS = fake;
const { createTools } = await import('../tools.mjs');
const noop = async () => {};
const { tools } = createTools({ allowActions: () => true, ui: () => {}, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
const tool = (n) => tools.find((t) => t.name === n);
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ctx = { toolCallId: 't1' };

// read_window / take_screenshot inside act_in_app steps are dropped, not a failed call.
fs.writeFileSync(log, '');
const r = await tool('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'key', key: 'cmd+end' }, { do: 'read_window' }, { do: 'type', text: 'hi' }] }, ctx);
assert.match(r, /key, type/);
const act = calls().find((c) => c[0] === 'act');
assert.deepEqual(JSON.parse(act[1]).steps.map((s) => s.do), ['key', 'type']);
assert.ok(!calls().some((c) => c[0] === 'capture'), 'no window pictures taken while it works in an app');
await assert.rejects(tool('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'read_window' }] }, ctx), /only read the window/);

// Screenshots ask the helper to shrink to 1568 px and use the size it reports.
fs.writeFileSync(log, '');
const shot = await tool('take_screenshot').execute({ target: 'TextEdit' }, ctx);
assert.match(shot.content[0].text, /800×600 px/);
assert.ok(calls().some((c) => c[0] === 'capture' && c[3] === '1568'));
// Shot at once with nothing shown on screen: no window lookup first, no preview copy for an animation.
assert.ok(!calls().some((c) => c[0] === 'locate'), 'no locate round trip before the shot');
assert.equal(calls().find((c) => c[0] === 'capture').length, 4, 'no preview thumbnail requested');

// An app that isn't installed: one clear answer instead of "No matching window".
await assert.rejects(tool('act_in_app').execute({ target: 'NoSuchAppRoamiesTest', steps: [{ do: 'key', key: 'return' }] }, ctx), /no app called "NoSuchAppRoamiesTest"/);
await assert.rejects(tool('open').execute({ target: 'NoSuchAppRoamiesTest' }, ctx), /no app called "NoSuchAppRoamiesTest"/);

// A bare web address opens as a link (in the app asked for), not as an app called "example.com".
const opened = await tool('open').execute({ target: 'example.invalid-tld-roamies.test', app: 'NoSuchAppRoamiesTest' }, ctx).catch((e) => String(e.message));
assert.match(opened, /no app called "NoSuchAppRoamiesTest"/, 'treated as a link opened in the named app');

// draw: a walkthrough waits for each click, and each next step is looked up only after it (the screen has changed).
{
  fs.writeFileSync(log, '');
  const sent = [], spoken = [], other = [];
  let clicks = 0;
  const made = createTools({
    allowActions: () => true, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test',
    speak: (t) => { spoken.push(t); return true; },
    ui: (m) => {
      if (m.e?.type?.startsWith('ink_')) other.push(m.e);
      if (m.e?.type !== 'draw') return;
      sent.push({ ...m.e, lookups: calls().filter((c) => c[0] === 'find-text').map((c) => c[2]) });
      setImmediate(() => {
        made.ink.started(m.e.id, m.e.seg);
        const last = m.e.beats.at(-1);
        if (last?.wait) setTimeout(() => { clicks++; made.ink.waitDone(m.e.id, last.n, 'clicked'); }, 5);
      });
    },
  });
  const draw = made.tools.find((t) => t.name === 'draw');
  const step = (say, text) => ({ say, marks: [{ kind: 'target', at: { text }, label: text }], wait: 'click' });
  const res = await draw.execute({ beats: [step('[warm] Open Format first.', 'Format'), step('Then pick High.', 'High')] }, { toolCallId: 'd1' });
  assert.equal(clicks, 2);
  assert.deepEqual(sent.map((e) => [e.seg, e.beats.map((b) => b.n), e.last]), [[0, [1], false], [1, [2], true]], 'one segment per waiting step');
  assert.deepEqual(sent[0].lookups, ['Format'], 'step 2 is not looked up before step 1 is clicked');
  assert.deepEqual(sent[1].lookups, ['Format', 'High']);
  assert.deepEqual(sent[0].beats[0].at, undefined);
  assert.deepEqual(sent[0].beats[0].marks[0].at.rect, [100, 100, 80, 24], 'exact bounds from the helper');
  assert.equal(sent[0].beats[0].caption, 'Open Format first.', 'the caption drops voice cues');
  assert.equal(sent[0].beats[0].voiced, true);
  assert.deepEqual(spoken, ['[warm] Open Format first.', 'Then pick High.'], 'each line is spoken when its step starts');
  assert.match(res, /Drew p1 target “Format”, p2 target “High”\..*Beat 1: Test clicked\..*Beat 2: Test clicked\./);
  // An explanation without waits: each beat goes out as soon as its own places are found (the first marks draw while
  // the rest are looked up), all spoken in order, and the same words are looked up once.
  sent.length = 0; spoken.length = 0; fs.writeFileSync(log, '');
  const ring = (text) => ({ kind: 'ring', at: { text } });
  await draw.execute({ beats: [{ say: 'One.', marks: [ring('A'), { kind: 'connect', at: { text: 'A' }, to: { text: 'B' } }] }, { say: 'Two.', marks: [ring('C')] }, { say: 'Three.', marks: [ring('D')] }] }, { toolCallId: 'd5' });
  assert.deepEqual(sent.map((e) => [e.seg, e.last]), [[0, false], [1, false], [2, true]]);
  assert.deepEqual(sent[0].lookups, ['A', 'B'], 'beat 1 is sent before beats 2 and 3 are looked up, and "A" is looked up once');
  assert.deepEqual(spoken, ['One.', 'Two.', 'Three.']);
  // Edits name what's there; unknown parts are refused with the list.
  await assert.rejects(draw.execute({ edit: [{ do: 'recolor', part: 'p9', tone: 'red' }] }, { toolCallId: 'd2' }), /no p9 on screen now \(there is: p1 target “Format”, p2 target “High”, p3 ring “A”/);
  assert.match(await draw.execute({ edit: [{ do: 'recolor', part: 'p1', tone: 'red' }] }, { toolCallId: 'd3' }), /Edited the drawing/);
  // A drawing in a later request replaces the old one, cards and all; an edit in a later request keeps it.
  made.nextTurn();
  await draw.execute({ edit: [{ do: 'recolor', part: 'p1', tone: 'amber' }] }, { toolCallId: 'd6' });
  assert.ok(!other.some((e) => e.type === 'ink_clear'), 'editing keeps the drawing');
  made.nextTurn();
  await draw.execute({ beats: [{ say: 'A card.', marks: [{ kind: 'note', text: 'hi' }] }] }, { toolCallId: 'd7' });
  assert.deepEqual(other.at(-1), { type: 'ink_clear' }, 'everything cleared, not just the screen marks');
  assert.match(await draw.execute({ beats: [{ say: 'Another.', marks: [{ kind: 'note', text: 'two' }] }] }, { toolCallId: 'd8' }), /On screen now: p\d+ note “hi”, p\d+ note “two”\./, 'same request: cards add up');
  // Another window comes to the front: the whole drawing goes (cards too), and the model is told nothing is there.
  fs.writeFileSync(path.join(dir, 'front.json'), JSON.stringify({ id: 9, app: 'Safari', title: 'x', bounds: [0, 0, 900, 700] }));
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(other.at(-1).type, 'ink_stale');
  await assert.rejects(draw.execute({ edit: [{ do: 'erase', part: 'p1' }] }, { toolCallId: 'd9' }), /nothing is drawn/);
  fs.rmSync(path.join(dir, 'front.json'));
  // A drawing that goes by itself (the tour, the setup showcase) is about no window: switching windows keeps it.
  other.length = 0;
  await made.ink.show([{ say: 'Graphs too.', marks: [{ kind: 'note', text: 'a showcase card' }] }], 'showcase-1', { fade: 5 });
  fs.writeFileSync(path.join(dir, 'front.json'), JSON.stringify({ id: 11, app: 'Notes', title: 'y', bounds: [0, 0, 900, 700] }));
  await new Promise((r) => setTimeout(r, 1800));
  assert.ok(!other.some((e) => e.type === 'ink_stale'), 'the showcase stays when another window comes to the front');
  assert.match(made.ink.describe(), /note “a showcase card”/);
  fs.rmSync(path.join(dir, 'front.json'));
  // Typing goes through the helper's fill (the same path as act_in_app).
  fs.writeFileSync(log, '');
  await draw.execute({ beats: [{ say: 'Your email goes here.', marks: [{ kind: 'type', at: { text: 'Email' }, text: 'a@b.com' }] }] }, { toolCallId: 'd4' });
  assert.deepEqual(JSON.parse(calls().find((c) => c[0] === 'act')[1]).steps, [{ do: 'fill', field: 'Email', text: 'a@b.com' }]);
  console.log('draw tool tests: passed');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('hands tests: passed');

// Live "where am I" line: app, window title and page, without query strings; '' when nothing is known.
{
  const { frontLine } = await import('../tools.mjs');
  const l = frontLine({ app: 'Google Chrome', title: 'Inbox (3) - me@example.com - Gmail', url: 'https://mail.google.com/mail/u/0/?tab=rm&token=SECRET#inbox' }, 'Ken');
  assert.match(l, /Right now Ken is in Google Chrome — "Inbox \(3\) - me@example.com - Gmail" \(mail\.google\.com\/mail\/u\/0\)/);
  assert.match(l, /overrides any app or page from earlier/);
  assert.ok(!/SECRET|tab=/.test(l), 'query string dropped');
  assert.equal(frontLine({ app: 'Notes', url: 'file:///Users/x/secret.txt' }), '- Right now The user is in Notes. This was just checked and overrides any app or page from earlier messages; they can still ask about something elsewhere.');
  assert.equal(frontLine({}), '');
  assert.equal(frontLine(null), '');
  console.log('front line tests: passed');
}
