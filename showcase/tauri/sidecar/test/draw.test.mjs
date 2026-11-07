// The draw tool's schema, places, parts, SMILES and picture fetching. Run: npm test
import assert from 'node:assert/strict';
import { DrawArgs, LIMITS, checkDraw, createParts, describeParts, faviconFor, parseSmiles, photoFor, resolveTargets, shapeRadius } from '../draw.mjs';

// ---- schema and limits
const ok = (a) => DrawArgs.safeParse(a).success;
assert.ok(ok({ beats: [{ say: 'Click Export.', marks: [{ kind: 'target', at: { text: 'Export' }, label: 'Export' }], wait: 'click' }] }), 'a walkthrough step');
assert.ok(ok({ edit: [{ do: 'recolor', part: 'p2', tone: 'red' }] }), 'edits alone');
assert.ok(!ok({ beats: [{ say: '', marks: [] }] }), 'a beat needs a line');
assert.ok(!ok({ beats: [{ say: 'x', marks: [{ kind: 'explode' }] }] }), 'unknown mark');
assert.ok(!ok({ beats: Array.from({ length: LIMITS.beats + 1 }, () => ({ say: 'x', marks: [] })) }), 'too many beats');
assert.ok(!ok({ beats: [{ say: 'x', marks: Array.from({ length: LIMITS.marks + 1 }, () => ({ kind: 'point', at: { x: 1, y: 1 } })) }] }), 'too many marks');
assert.ok(!ok({ beats: [{ say: 'x', marks: [{ kind: 'note', text: 'hi', tone: 'neon' }] }] }), 'unknown tone');
assert.ok(!ok({ beats: [{ say: 'x', marks: [], wait: 'forever' }] }), 'unknown wait');
assert.deepEqual(checkDraw({}), ['Give beats to draw, or edit to change what is drawn.']);
assert.deepEqual(checkDraw({ beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text: 'Share' } }] }] }), []);
assert.match(checkDraw({ beats: [{ say: 'x', marks: [{ kind: 'ring' }] }] })[0], /beat 1 mark 1 \(ring\): needs at/);
assert.match(checkDraw({ beats: [{ say: 'x', marks: [{ kind: 'connect', at: { text: 'a' } }] }] })[0], /needs to/);
assert.match(checkDraw({ beats: [{ say: 'x', marks: [{ kind: 'trace', points: [[1, 1]] }] }] })[0], /needs points/);
assert.match(checkDraw({ beats: [{ say: 'x', marks: [{ kind: 'note', text: 'n' }], wait: 'click' }] })[0], /wait needs a mark/);
assert.match(checkDraw({ beats: [{ say: 'x', marks: [{ kind: 'button', text: 'Next' }] }] })[0], /needs action/);
assert.match(checkDraw({ beats: [{ say: 'x', marks: [{ kind: 'emote', name: 'dance' }] }] })[0], /needs name/);
assert.match(checkDraw({ beats: [{ say: 'x', marks: [{ kind: 'molecule', smiles: 'C[C@H]O' }] }] })[0], /not a supported bracket atom/);
assert.match(checkDraw({ edit: [{ do: 'recolor', part: 'p1' }] })[0], /recolor needs tone/);
assert.match(checkDraw({ edit: [{ do: 'erase' }] })[0], /needs part/);
assert.deepEqual(checkDraw({ edit: [{ do: 'clear' }] }), [], 'start over needs no part');
console.log('draw schema tests: passed');

// ---- the shape rule: round for small square things, a pill for thin ones, a rounded box for big ones and fields
assert.equal(shapeRadius(24, 24, 'checkbox'), 12, 'checkbox is round');
assert.equal(shapeRadius(90, 28, 'button'), 14, 'thin button is a pill');
assert.equal(shapeRadius(64, 60, 'button'), 30, 'small square button is round');
assert.equal(shapeRadius(300, 200, ''), 18, 'big area: gently rounded');
assert.equal(shapeRadius(300, 28, 'text field'), 4, 'a field stays a box even when thin');
assert.equal(shapeRadius(300, 28, 'button', 6), 6, 'r overrides');
console.log('shape radius tests: passed');

// ---- places, with a fake screen
{
  const seen = [];
  const look = {
    text: async (t) => { seen.push(['text', t]); if (t === 'Missing') throw new Error('No button reads "Missing"'); return { bounds: [100, 200, 80, 24], role: 'button', text: t }; },
    id: async (n) => { seen.push(['id', n]); return { id: n + 1, bounds: [10, 10, 24, 24], role: 'checkbox', label: 'Agree' }; },
    pixel: async (x, y) => [x * 2, y * 2 + 40],
  };
  const beats = [{ say: 'Open Format, then tick Agree.', marks: [
    { kind: 'target', at: { text: 'Format' }, label: 'Format' },
    { kind: 'ring', at: { id: 7 } },
    { kind: 'point', at: { x: 10, y: 10 } },
    { kind: 'frame', at: { x: 10, y: 10, w: 50, h: 20 } },
    { kind: 'trace', points: [[0, 0], [10, 0], [10, 10]] },
    { kind: 'connect', at: { text: 'Format' }, to: { x: 5, y: 5 } },
    { kind: 'molecule', smiles: 'CCO' },
    { kind: 'note', text: 'remember' },
  ], wait: 'click' }];
  const [b] = await resolveTargets(beats, look);
  assert.equal(b.wait, 'click');
  assert.deepEqual(b.marks[0].at, { rect: [100, 200, 80, 24], r: 12, role: 'button', name: 'Format' }, 'text: exact bounds, pill');
  assert.deepEqual(b.marks[1].at, { rect: [10, 10, 24, 24], r: 12, role: 'checkbox', name: 'Agree', live: 8 }, 'id: the live control');
  assert.deepEqual(b.marks[2].at.rect, [6, 46, 28, 28], 'a pixel: a small spot round it');
  // Regression: x, y with w, h was read as the top-left corner while models gave the centre, so loops sat low and right.
  assert.deepEqual(b.marks[3].at.rect, [-30, 40, 100, 40], 'pixels with w, h: x, y is the centre, both corners mapped');
  assert.deepEqual(b.marks[4].points, [[0, 40], [20, 40], [20, 60]], 'paths map every point');
  assert.deepEqual(b.marks[5].to.rect, [-4, 36, 28, 28]);
  assert.equal(b.marks[6].mol.atoms.length, 3, 'molecules are parsed for the overlay');
  assert.equal(b.marks[7].at, undefined, 'cards need no place');
  await assert.rejects(resolveTargets([{ say: 'x', marks: [{ kind: 'ring', at: { text: 'Missing' } }] }], look), /beat 1 mark 1 \(ring\): No button reads "Missing"/);
  // With the app's controls known, a pixel loop near one snaps to it; text and point marks don't ask.
  const asked = [];
  const [s2] = await resolveTargets([{ say: 'x', marks: [{ kind: 'ring', at: { x: 10, y: 10, w: 50, h: 20 } }, { kind: 'point', at: { x: 5, y: 5 } }] }], { ...look, snap: async (r) => { asked.push(r); return [-28, 42, 100, 40]; } });
  assert.deepEqual(s2.marks[0].at.rect, [-28, 42, 100, 40], 'snapped to the control');
  assert.equal(asked.length, 1, 'only the loop with w, h snaps');
  console.log('draw target tests: passed');
}

// ---- parts: ids in order, never reused; screen marks clear on their own, cards stay
{
  const p = createParts();
  const ids = p.assign([{ marks: [{ kind: 'ring', at: { name: 'Export' } }, { kind: 'emote', name: 'hype' }, { kind: 'card', heading: 'Interest' }] }]);
  assert.deepEqual(ids, ['p1', 'p2'], 'emotes get no id');
  assert.equal(p.describe(), 'p1 ring “Export”, p2 card “Interest”');
  assert.equal(p.screenCount, 1);
  p.clearScreen();
  assert.deepEqual(p.ids, ['p2'], 'the card stays');
  assert.deepEqual(p.assign([{ marks: [{ kind: 'label', text: 'here', at: {} }] }]), ['p3'], 'ids are never reused');
  p.remove('p2');
  assert.equal(p.has('p2'), false);
  assert.equal(describeParts([['p9', { desc: 'note “x”' }]]), 'p9 note “x”');
  console.log('draw parts tests: passed');
}

// ---- SMILES
{
  const hs = (s) => parseSmiles(s).atoms.map((a) => a.el + (a.h || '')).join(' ');
  assert.equal(hs('CCO'), 'C3 C2 O1', 'ethanol');
  assert.equal(hs('c1ccccc1'), 'C1 C1 C1 C1 C1 C1', 'benzene');
  assert.equal(hs('c1cc[nH]c1'), 'C1 C1 C1 N1 C1', 'pyrrole');
  assert.equal(hs('Cn1cnc2c1c(=O)n(C)c(=O)n2C'), 'C3 N C1 N C C C O N C3 C O N C3', 'caffeine');
  assert.equal(hs('O=C=O'), 'O C O', 'carbon dioxide');
  assert.equal(hs('C#N'), 'C1 N', 'hydrogen cyanide');
  const nh4 = parseSmiles('[NH4+]').atoms[0];
  assert.deepEqual(nh4, { el: 'N', arom: false, charge: 1, h: 4 }, 'bracket atom with charge');
  assert.equal(parseSmiles('[O-]C=O').atoms[0].charge, -1);
  assert.equal(parseSmiles('[Fe+2]').atoms[0].charge, 2);
  assert.equal(parseSmiles('C1CC%10CC1%10').bonds.length, 6, 'two-digit ring closures');
  assert.deepEqual(parseSmiles('C=C').bonds, [{ a: 0, b: 1, order: 2 }]);
  assert.equal(parseSmiles('c1ccccc1').bonds.filter((b) => b.order === 1.5).length, 6, 'aromatic bonds');
  assert.equal(parseSmiles('CC(C)(C)C').bonds.length, 4, 'branches');
  for (const bad of ['', 'C[C@H](O)C', 'CC.O', 'C/C=C/C', 'C1CC', 'C(C', 'C)C', '[13C]', 'C=', 'Xx', 'C==C'])
    assert.throws(() => parseSmiles(bad), /SMILES|empty/, `refuses ${JSON.stringify(bad)}`);
  assert.throws(() => parseSmiles('C'.repeat(LIMITS.atoms + 1)), /more than/);
  console.log('smiles tests: passed');
}

// ---- photos and favicons go through the URL rules, with size caps
{
  const calls = [];
  const res = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => Buffer.from(body) });
  const png = Buffer.from([137, 80, 78, 71]);
  const fake = (routes) => async (url) => { calls.push(url); const r = routes[url]; if (!r) return res(404, ''); return r(); };
  const wiki = fake({
    'https://en.wikipedia.org/api/rest_v1/page/summary/Jet_engine': () => res(200, JSON.stringify({ title: 'Jet engine', thumbnail: { source: 'https://upload.wikimedia.org/jet.png' } }), { 'content-type': 'application/json' }),
    'https://upload.wikimedia.org/jet.png': () => res(200, png, { 'content-type': 'image/png' }),
  });
  const p = await photoFor({ query: 'jet engine' }, { fetchImpl: wiki });
  assert.equal(p.src, `data:image/png;base64,${png.toString('base64')}`, 'a data URL the overlay can dither');
  assert.equal(p.title, 'Jet engine');
  await assert.rejects(photoFor({ url: 'http://192.168.0.2/cam.png' }, { fetchImpl: wiki }), /Blocked for safety/, 'local network');
  const bounce = fake({ 'https://example.com/a.png': () => res(302, '', { location: 'http://localhost/secret.png' }) });
  await assert.rejects(photoFor({ url: 'https://example.com/a.png' }, { fetchImpl: bounce }), /Blocked for safety/, 'a redirect to this computer');
  const big = fake({ 'https://example.com/big.png': () => res(200, Buffer.alloc(LIMITS.photoBytes + 1), { 'content-type': 'image/png' }) });
  await assert.rejects(photoFor({ url: 'https://example.com/big.png' }, { fetchImpl: big }), /too big/);
  const html = fake({ 'https://example.com/page': () => res(200, '<html>', { 'content-type': 'text/html' }) });
  await assert.rejects(photoFor({ url: 'https://example.com/page' }, { fetchImpl: html }), /isn't a picture/);
  const ico = fake({ 'https://news.example.org/favicon.ico': () => res(200, png, { 'content-type': 'image/x-icon' }) });
  assert.match(await faviconFor('https://news.example.org/story?id=1', { fetchImpl: ico }), /^data:image\/x-icon;base64,/);
  const n = calls.length;
  await faviconFor('https://news.example.org/other', { fetchImpl: ico });
  assert.equal(calls.length, n, 'favicons are cached per site');
  assert.equal(await faviconFor('https://nothing.example.net/', { fetchImpl: fake({}) }), null, 'no favicon: a dot instead');
  assert.equal(await faviconFor('javascript:alert(1)'), null, 'not a web link');
  console.log('photo and favicon tests: passed');
}

// Regression: a timeline event of 41+ characters failed the whole draw call; event text wraps now, up to 60.
{
  const tl = (text) => ({ beats: [{ say: 'When.', marks: [{ kind: 'timeline', events: [{ when: 'c. 330 BC', text }] }] }] });
  assert.ok(ok(tl('Aristotle gives strong evidence for a round Earth')), 'a 49-character event');
  assert.ok(!ok(tl('x'.repeat(61))), 'past 60 still fails');
  console.log('timeline schema tests: passed');
}
