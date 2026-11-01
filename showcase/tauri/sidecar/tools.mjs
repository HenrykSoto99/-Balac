// The agent's tools: screen capture, reading and working other apps (macOS "hands" helper), files, commands,
// web pages and memory. Every file, command, URL and open goes through safety.mjs first.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { parseSipsSize, readProblem, rematch, sameBounds, shotMap, shotProblem, toScreen } from './pointing.mjs';
import { ASK, BLOCK, checkOpen, checkRead, checkUrl, checkWrite, classifyCommand, isRiskyClick, isYes } from './safety.mjs';
import { addCommitment, addFact, forgetFact, parseDue, updateCommitment } from './store.mjs';

const HOME = os.homedir();
export const expand = (p) => path.resolve(String(p).replace(/^~(?=$|\/|\\)/, HOME));
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…(${s.length - n} more characters)` : s);
// windowsHide: no console window flashing up for each command or screenshot on Windows.
export const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { maxBuffer: 8 << 20, timeout: 60_000, windowsHide: true, ...opts }, (err, stdout, stderr) => res({ err, stdout: String(stdout), stderr: String(stderr) })));
// Windows "open": Start-Process gets the target through an environment variable, so nothing in it is ever
// parsed as a command (cmd's start split URLs at "&", and quotes in names broke it).
export const winOpen = (target) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:ROAMIES_OPEN'], { env: { ...process.env, ROAMIES_OPEN: target } });
const actionsOff = `File edits and commands are switched off. Tell the user to turn on "Allow File Edits & Commands" in the ${process.platform === 'darwin' ? 'menu bar' : 'system tray'} menu if they want this.`;

// macOS "hands": the bundled helper that captures one window or area and reads/controls other apps.
const HANDS = process.env.ROAMIES_HANDS || '';
const STALE_ID = 'The page changed since read_window, so that id is out of date. Call read_window again and use the new ids.';
// The text point_at should use: a whole label or heading (exact or word match), not the words buried in a
// paragraph, which is what a guessed word like "version" or "settings" tends to hit.
function pickTextMatch(matches, find) {
  const q = String(find).trim();
  return (matches ?? []).find((m) => m.match !== 'partial' && m.text.trim().length <= Math.max(40, q.length * 3)) ?? null;
}
// Like run(), but hands each "@{json}" line the helper writes to stderr to onLine as it arrives.
function runLive(cmd, args, onLine) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stdout = '', stderr = '', buf = '';
    const timer = setTimeout(() => p.kill(), 120_000);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.startsWith('@')) { try { onLine(JSON.parse(line.slice(1))); } catch {} } else stderr += line + '\n';
      }
    });
    p.on('error', (err) => { clearTimeout(timer); res({ err, stdout, stderr }); });
    p.on('close', (code) => { clearTimeout(timer); res({ err: code ? new Error(`exit ${code}`) : null, stdout, stderr: stderr + buf }); });
  });
}
// An app named in read_window or act_in_app that isn't open: open it (with the open tool's safety check) and wait
// up to 6 s for its window. True when it's there. Only plain app names, never paths or links.
async function launchApp(name, hands) {
  const n = String(name).trim();
  if (process.platform !== 'darwin' || !n || /[/\\:]/.test(n) || checkOpen(n, HOME).level === BLOCK) return false;
  // Opened only to act in it: in background mode (the default) it opens behind the user's app, not in front.
  const r = await run('open', [...(process.env.ROAMIES_BG !== '0' ? ['-g'] : []), '-a', n]);
  if (r.err && /Unable to find application/i.test(r.stderr)) throw new Error(`There's no app called "${n}" on this Mac (not installed, or it has another name). Don't look for it another way; say so and carry on with the rest.`);
  if (r.err) return false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await hands('locate', `app:${n}`).then((r) => r?.ok !== false && r?.window, () => false)) { await new Promise((r) => setTimeout(r, 300)); return true; }
  }
  return false;
}
// read_window and act_in_app output: visible controls first, then up to 15 scrolled out of view.
function controlList(controls, texts = []) {
  const vis = controls.filter((c) => !c.offscreen), off = controls.filter((c) => c.offscreen).slice(0, 15);
  const line = (c) => `${c.id} ${c.role}${c.label ? ` "${c.label}"` : ''}${c.value ? ` = "${c.value}"` : ''}${c.focused ? ' (focused)' : ''}`;
  const labels = new Set(controls.map((c) => c.label));
  const words = texts.filter((t) => !labels.has(t));
  return vis.map(line).join('\n')
    + (off.length ? `\nFurther down (point_at or click_text scrolls to them): ${off.map((c) => `${c.id} "${c.label || c.role}"`).join(', ')}` : '')
    + (words.length ? `\nText on screen: ${words.join(' | ')}` : '');
}
// A safety verdict: blocked throws with the reason, otherwise returns the checked absolute path.
const allowed = (v) => { if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason}`); return v.path; };
// Shrinks an image to at most 1568 px on its long side (Claude's own cap), never enlarging small ones. Returns [w, h].
export async function fitImage(file) {
  const size = async () => parseSipsSize((await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])).stdout);
  const s = await size();
  if (!s || Math.max(...s) <= 1568) return s;
  await run('sips', ['-Z', '1568', file]);
  return size();
}
export const imageBlock = async (file, mediaType) => {
  const data = (await fs.readFile(file)).toString('base64');
  fs.unlink(file).catch(() => {});
  return { type: 'image', mediaType, data };
};

// deps: what the tools need from the app (settings, overlay, input bubble, menu). State lives per instance.
const BROWSERS = /^(browser|safari|google chrome|chrome|arc|firefox|microsoft edge|edge|brave browser|brave|opera|vivaldi)$/i;
const ADDRESS = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;
/** The web address an act_in_app call only types into a browser's address bar (then Return, then maybe a wait), or null. */
export function typedAddress(target, steps) {
  if (!BROWSERS.test(String(target).trim())) return null;
  const i = steps.findIndex((s) => s.do === 'type');
  if (i < 0 || !ADDRESS.test(String(steps[i].text ?? '').trim()) || /\.app$/i.test(steps[i].text)) return null;
  const bar = /address|search field|smart search|url|location|new tab|omnibox/i;
  const before = steps.slice(0, i).every((s) => (s.do === 'key' && /^(cmd|command)\+(l|t)$/i.test(String(s.key).replace(/\s/g, ''))) || (s.do === 'click_text' && bar.test(s.text ?? '')));
  const ret = steps[i + 1]?.do === 'key' && /^(return|enter)$/i.test(String(steps[i + 1].key).trim());
  const after = steps.slice(i + 2).every((s) => s.do === 'wait');
  return before && ret && after ? String(steps[i].text).trim() : null;
}

export function createTools({ allowActions, ui, ask, openUrl, onCommitments, showList, fmtWhen, commitmentsText, userName, onPlan = () => {} }) {
  let axNudged = 0;
  const pointWaits = new Map(); // point_at call id → resolve, settled when the overlay has shown the step
  let lastShot = null; // how the latest screenshot's pixels map to screen points (see pointing.mjs)
  let lastRead = null; // { win, controls } from the latest read_window, to catch ids that went stale
  // Bumped for every new request: what was seen before it may be another page, tab or app by now.
  let turn = 0;
  async function shotPoint(x, y) {
    const problem = shotProblem(lastShot, turn);
    if (problem) throw new Error(problem);
    if (lastShot.win != null) {
      const now = await hands('locate', `window:${lastShot.win}`).catch(() => null);
      if (!sameBounds(now?.window?.bounds, lastShot.bounds)) throw new Error('That window moved or closed since the screenshot. Take a new screenshot first.');
    }
    return toScreen(lastShot, x, y);
  }
  // The control that read_window listed at this id, wherever it is now.
  async function liveControls(spec) {
    // Only the controls: the page's text isn't needed to re-find ids.
    const fresh = await hands('ui', spec, 'controls');
    const problem = readProblem(lastRead, fresh.window.id, turn);
    if (problem) throw new Error(problem);
    return (id) => {
      const c = rematch(lastRead.controls[id - 1], fresh.controls, id);
      if (!c) throw new Error(STALE_ID);
      return c;
    };
  }
  // onProgress: the helper's live "@{...}" lines on stderr while it acts (steps, borrowing the cursor), as objects.
  async function hands(...args) {
    if (!HANDS) throw new Error('This needs the Roamies app on macOS.');
    const onProgress = typeof args.at(-1) === 'function' ? args.pop() : null;
    const r = onProgress ? await runLive(HANDS, args, onProgress) : await run(HANDS, args, { timeout: 120_000 });
    let res;
    try { res = JSON.parse(r.stdout.trim().split('\n').pop() || '{}'); } catch { throw new Error(`hands helper failed: ${r.stderr.trim().slice(0, 200) || 'no output'}`); }
    if (res.ok === false && !res.cancelled) {
      if (/Accessibility/i.test(res.error ?? '')) {
        // Open the exact Settings pane (once a minute at most) so the fix is one click away.
        if (Date.now() - axNudged > 60_000) { axNudged = Date.now(); openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'); }
        throw new Error('Accessibility is off for Roamies, so I can\'t read or control other apps yet. I just opened System Settings → Privacy & Security → Accessibility: switch on Roamies there, then ask again. Tell the user exactly that, briefly.');
      }
      throw new Error(res.error || 'That did not work.');
    }
    return res;
  }
  // A yes/no in an input bubble. Stop (or the turn ending) counts as no.
  async function confirm(question, ctx) {
    const answer = await ask({ placeholder: question }, ctx?.signal);
    return isYes(answer);
  }

  // target: "screen", "front" (the window you're working in), an app name ("browser", "Safari", "Figma"),
  // or "window:<id>" from list_windows. Apps that are open but hidden or minimised are brought forward.
  async function screenshot({ target = 'screen' } = {}, ctx) {
    const file = path.join(os.tmpdir(), `sidekick-${Date.now()}.jpg`);
    if (process.platform === 'darwin') {
      const t = String(target || 'screen').trim();
      const spec = t === 'screen' || t === 'front' || t.startsWith('window:') ? t : `app:${t}`;
      // Find the window first so the camera animation can frame the real thing (screen points), then shoot while it
      // flies there (the shot is of that window alone, so the animation isn't in it); the result waits for the animation.
      let shown = Promise.resolve();
      if (spec !== 'screen' && ctx?.toolCallId) {
        const at = await hands('locate', spec).catch(() => null);
        if (at?.window) {
          ui({ kind: 'agent', e: { type: 'tool_target', id: ctx.toolCallId, window: at.window } });
          shown = new Promise((r) => setTimeout(r, 250));
        }
      }
      // 1568 px is Claude's own cap; a bigger image gets shrunk again and its coordinates drift. The helper shrinks it
      // itself and says the final size; an older helper doesn't, so sips does it here.
      const thumb = ctx?.toolCallId ? `${file.slice(0, -4)}-peek.jpg` : null;
      const [res] = await Promise.all([hands('capture', file, spec, '1568', ...(thumb ? [thumb, '900'] : [])), shown]);
      // The Sidekick shows what it actually took: in its frame and on the photo it carries back.
      if (thumb && existsSync(thumb)) {
        const b64 = (await fs.readFile(thumb)).toString('base64');
        ui({ kind: 'agent', e: { type: 'tool_image', id: ctx.toolCallId, src: `data:image/jpeg;base64,${b64}` } });
        fs.unlink(thumb).catch(() => {});
      }
      const size = Array.isArray(res.pixels) && res.pixels.length === 2 ? res.pixels : await fitImage(file);
      const bounds = res.window?.bounds ?? res.bounds;
      lastShot = size && bounds ? { ...shotMap(bounds, ...size), bounds, win: res.window?.id ?? null, turn } : null;
      const what = res.window ? `the ${res.window.app} window${res.window.title ? ` "${res.window.title}"` : ''}` : 'the whole screen';
      const dims = size ? ` (${size[0]}×${size[1]} px; for point_at or click_at give x, y in this image's pixels)` : '';
      return { content: [{ type: 'text', text: `Screenshot of ${what}${dims}.` }, await imageBlock(file, 'image/jpeg')] };
    } else if (process.platform === 'win32') {
      // DPI-aware (or scaled displays capture only the top-left part), shrunk to Claude's 1568 px cap, and the
      // file path passed by environment variable so odd characters in it can't break the script.
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        "Add-Type -Name D -Namespace RoamiesWin -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'",
        '[RoamiesWin.D]::SetProcessDPIAware() | Out-Null',
        '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
        '$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
        '[System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)',
        '$s=[Math]::Min(1.0,1568.0/[Math]::Max($b.Width,$b.Height))',
        '$o=New-Object System.Drawing.Bitmap ([int]($b.Width*$s)),([int]($b.Height*$s))',
        "$g=[System.Drawing.Graphics]::FromImage($o);$g.InterpolationMode='HighQualityBicubic';$g.DrawImage($i,0,0,$o.Width,$o.Height)",
        '$o.Save($env:ROAMIES_SHOT,[System.Drawing.Imaging.ImageFormat]::Jpeg)',
      ].join(';');
      // -EncodedCommand (UTF-16LE base64): no quoting for Windows' command line to mangle.
      const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { env: { ...process.env, ROAMIES_SHOT: file } });
      if (r.err) throw new Error('Screen capture failed.');
    } else {
      let r = await run('grim', [file]);
      if (r.err) r = await run('gnome-screenshot', ['-f', file]);
      if (r.err) throw new Error('No screenshot tool found (install grim or gnome-screenshot).');
    }
    const data = (await fs.readFile(file)).toString('base64');
    fs.unlink(file).catch(() => {});
    return { content: [{ type: 'text', text: 'Screenshot of the main display.' }, { type: 'image', mediaType: 'image/jpeg', data }] };
  }

  const tools = [
    {
      name: 'take_screenshot',
      description: "Look at the user's screen. target: 'front' = just the window they're working in (best default when they say 'this' or 'here'), an app name like 'browser', 'Safari', 'Figma' or 'Notes' (works even if it's hidden behind other windows), 'window:<id>' from list_windows, or 'screen' for everything.",
      parameters: z.object({ target: z.string().optional() }), execute: screenshot,
    },
    ...(process.platform === 'darwin' ? [
      {
        name: 'list_windows', description: 'List the open app windows (app, title, id), front to back.',
        parameters: z.object({}),
        execute: async () => {
          const res = await hands('windows');
          return res.windows.map((w) => `window:${w.id}  ${w.app}${w.title ? ` — ${w.title}` : ''}${w.frontApp ? '  (frontmost app)' : ''}`).join('\n') || 'No windows open.';
        },
      },
      {
        name: 'read_window',
        description: "List the buttons, links, fields, checkboxes and other controls in an app's front window (id, role, label, value), plus the text on screen and the text scrolled out of view above and below it, so you can read a whole page without scrolling or a screenshot. Needed before act_in_app steps that use ids. To point at or click something by its visible words you don't need this: use point_at or click_text with text. target: 'front', an app name, or 'browser'.",
        parameters: z.object({ target: z.string().optional() }),
        execute: async ({ target = 'front' }) => {
          const t = String(target || 'front');
          const read = () => Promise.all([hands('ui', t === 'front' ? 'front' : `app:${t}`), hands('windows').catch(() => null)]);
          const [res, all] = await read().catch(async (err) => {
            if (t === 'front' || !/No matching window/.test(String(err?.message ?? err)) || !(await launchApp(t, hands))) throw err;
            return read();
          });
          lastRead = { win: res.window.id, app: res.window.app, controls: res.controls, turn };
          const others = (all?.windows ?? []).filter((w) => w.app === res.window.app && w.id !== res.window.id).length;
          const head = `${res.window.app}${res.window.title ? ` — ${res.window.title}` : ''}${others ? ` (front window; ${res.window.app} has ${others} more, which point_at with text also searches)` : ''}`;
          if (!res.controls.length) return `${head}\n${res.note}`;
          return `${head}\n${controlList(res.controls, res.texts)}${res.elsewhere?.length ? `\nElsewhere on the page (scrolled out of view): ${res.elsewhere.join(' | ')}` : ''}`;
        },
      },
      {
        name: 'point_at',
        description: "Teach by showing: fly to something on screen and point at it while you explain one step. Use it to walk the user through how to do something (e.g. 'how do I add a layer mask'), one point_at per step, in order, with a short instruction each (under 12 words). Three ways to say where, best first: text, the exact words shown on screen (button and link labels, headings, version numbers, menu names; searches every window of the target app, or the whole screen with target 'screen', so no read_window is needed first); id from read_window, for controls without visible words; or x, y pixels from your latest screenshot, only when neither finds it. Set click true only if the user asked you to do it for them; otherwise just point and let them click. wait_for_user true pauses until they do the step (or 20 s), for multi-step lessons.",
        parameters: z.object({
          target: z.string().optional(),
          id: z.number().int().optional(), text: z.string().min(1).max(80).optional(), x: z.number().optional(), y: z.number().optional(),
          say: z.string().min(1).max(120),
          step: z.number().int().optional(), of: z.number().int().optional(),
          click: z.boolean().optional(), wait_for_user: z.boolean().optional(),
        }),
        executionMode: 'sequential',
        execute: async ({ target = 'front', id, text: find, x, y, say: text, step, of: total, click, wait_for_user }, ctx) => {
          const t = String(target || 'front'), spec = t === 'front' ? 'front' : t === 'screen' ? 'screen' : `app:${t}`;
          let rect, label = '', at, liveId;
          if (id != null) {
            const c = (await liveControls(spec))(id);
            if (c.offscreen) throw new Error(`"${c.label || c.role}" is further down the page. Use point_at with its text instead; that scrolls to it.`);
            rect = c.bounds; label = c.label || c.role; liveId = c.id;
          } else if (find) {
            // "front" searches every window of the front app; text is often in a window behind the frontmost one.
            const res = await hands('find-text', spec, find, 'scroll');
            const m = pickTextMatch(res.matches, find);
            if (!m) {
              const near = (res.matches ?? []).slice(0, 3).map((x) => `"${x.text.replace(/\s+/g, ' ').slice(0, 50)}"`).join(', ');
              throw new Error(`No button, label or heading reads "${find}"${near ? ` (it only appears inside longer text: ${near})` : ''}. Point at the exact words shown on screen; if you don't know them, take a screenshot first.`);
            }
            rect = m.bounds; label = m.text;
            if (click) at = [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
          } else if (x != null && y != null) {
            at = await shotPoint(x, y);
            rect = [at[0] - 14, at[1] - 14, 28, 28];
          } else throw new Error('Give an id from read_window, text shown on screen, or x and y from a screenshot.');
          // The overlay flies there, points, shows the step and holds; this tool resolves once it's on screen.
          const done = new Promise((resolve) => pointWaits.set(ctx.toolCallId, resolve));
          ui({ kind: 'agent', e: { type: 'point', id: ctx.toolCallId, rect, say: text, step, of: total, label } });
          await done;
          if (click) {
            if (!allowActions()) throw new Error(actionsOff);
            if (id != null) await hands('act', JSON.stringify({ steps: [{ do: 'click', id: liveId }], ...(t === 'front' ? {} : { app: t }) }));
            else await hands('act', JSON.stringify({ steps: [{ do: 'click_at', x: at[0], y: at[1], global: true }], ...(t === 'front' || t === 'screen' ? {} : { app: t }) }));
            if (lastShot) lastShot.used = true;
          } else if (wait_for_user) {
            // Give them time to do it themselves before the next step.
            await new Promise((r) => setTimeout(r, 6000));
          }
          return `Pointed at ${label || 'the spot'}${click ? ' and clicked it' : ''}.`;
        },
      },
      {
        name: 'act_in_app',
        description: "Do things in another app for the user: click, fill in forms, pick from dropdowns and date pickers, scroll, press keys. Steps run in order; put a whole task in one call. {do:'click_text', text} clicks a link, button or tab by its visible words (no read_window needed). {do:'fill', field, text} fills one text field: field is its label or placeholder as shown (or id), it replaces the text and checks it took; use one fill per field, never click a label and type. {do:'choose', field, option} picks an option in a dropdown, select menu, type-to-search box or picker: it opens it, types or scrolls through the list (hundreds of options, even lists that only load rows as they scroll) and picks; field is its label or id. Never scroll a dropdown list yourself. To go to a web address, use the open tool (instant), not the address bar. Many identical buttons or fields (a Reply under every post): add near, words from that item (author or first words of the post), to click_text or fill and it uses the one belonging to that item, scrolling to it. {do:'scroll', direction:'down'|'up'|'left'|'right', amount, text or id} scrolls the page, or the list or panel under that text or control; needed only for content that loads as you scroll: {do:'scroll', direction:'down', to_end:true} keeps going until the feed stops loading more, in one step; then read_window lists everything that loaded. Things already on the page don't need scrolling: click_text, fill and point_at find them anywhere on it and scroll there themselves. {do:'click', id}; {do:'key', key} e.g. 'return', 'tab', 'escape'; {do:'type', text} only when the cursor is already in a text field; {do:'click_at', x, y} pixels in your latest screenshot, last resort; {do:'wait', seconds}. Dates: fill the date field with the date as the page shows dates (e.g. 10/30/2026); if a calendar opens instead, choose the month and year, then click_text the day (its label often reads like 'Choose Friday, October 30th, 2026'). After the steps the result lists the window's controls and text as they are now (after scrolls too), with fresh ids and field values, so check them there instead of calling read_window again. Never submit payments, send messages or delete things unless the user clearly asked for exactly that; showing or pointing at a button is not a request to click it. Clicks on delete, pay, send or sign-out buttons always ask the user first, so when they asked you to click one, call act_in_app right away instead of asking in your reply; the app asks them.",
        parameters: z.object({
          target: z.string().optional(),
          steps: z.array(z.object({
            // read_window and take_screenshot aren't steps (the result already shows the window), but models put them
            // in anyway; they're dropped instead of failing the whole call.
            do: z.enum(['click_text', 'fill', 'choose', 'scroll', 'set', 'focus', 'click', 'type', 'key', 'click_at', 'wait', 'read_window', 'take_screenshot', 'screenshot']),
            id: z.number().int().optional(), field: z.string().optional(), text: z.string().optional(), option: z.string().optional(), near: z.string().optional(),
            key: z.string().optional(), direction: z.enum(['down', 'up', 'left', 'right']).optional(), amount: z.number().int().optional(), to_end: z.boolean().optional(),
            x: z.number().optional(), y: z.number().optional(), seconds: z.number().optional(),
          })).min(1).max(40),
        }),
        executionMode: 'sequential',
        execute: async ({ target = 'front', steps: given }, ctx) => {
          if (!allowActions()) throw new Error(actionsOff);
          const asked = String(target || 'front');
          const steps = given.filter((s) => !['read_window', 'take_screenshot', 'screenshot'].includes(s.do));
          if (!steps.length) throw new Error('Those steps only read the window. Use read_window or take_screenshot for that.');
          // "Type a web address into the browser's bar and press Return" is just opening a link: do that directly
          // (instant, and nothing can land in the wrong field) instead of clicking the bar and typing.
          const url = typedAddress(asked, steps);
          if (url) {
            const r = await tools.find((x) => x.name === 'open').execute({ target: url, app: /^(front|browser)$/i.test(asked) ? undefined : asked });
            return `${r} (went straight to the address instead of typing it)`;
          }
          // Stay on the exact window read for this request: an app can have several, and keystrokes must land in this one.
          const sameApp = lastRead?.turn === turn && (asked === 'front' || (lastRead.app ?? '').toLowerCase().includes(asked.toLowerCase()) || (asked.toLowerCase() === 'browser'));
          const t = sameApp ? `window:${lastRead.win}` : asked;
          // Ids up to the first click come from read_window; after a click the helper re-reads the page itself.
          const firstClick = steps.findIndex((s) => s.do === 'click' || s.do === 'click_text');
          const upTo = firstClick < 0 ? steps.length : firstClick + 1;
          const spec = t === 'front' || t.startsWith('window:') ? t : `app:${t}`;
          const live = steps.slice(0, upTo).some((s) => s.id != null) ? await liveControls(spec) : null;
          const mapped = [];
          for (const [i, s] of steps.entries()) {
            if (s.do === 'click_at' && s.x != null && s.y != null) { const [x, y] = await shotPoint(s.x, s.y); mapped.push({ ...s, x, y, global: true }); }
            else if (live && i < upTo && s.id != null) { const c = live(s.id); mapped.push({ ...s, id: c.id, label: c.label }); }
            else mapped.push(s);
          }
          // Delete, pay, send, sign out: ask first, whatever the request was. The helper refuses these clicks without it.
          for (const s of mapped) {
            const label = s.do === 'click_text' ? s.text : s.do === 'click' ? s.label : s.do === 'choose' ? s.option : null;
            if (label && isRiskyClick(label)) {
              if (!(await confirm(`Click "${label}"${asked === 'front' ? '' : ` in ${asked}`}? It could delete, pay, send or sign out. Type y to let me.`, ctx))) {
                throw new Error(`${userName} said no, so I didn't click "${label}" (nothing after it ran either).`);
              }
              s.confirmed = true;
            }
            delete s.label;
          }
          const plan = { steps: mapped, ...(t === 'front' ? {} : t.startsWith('window:') ? { window: +t.slice(7) } : { app: t }) };
          // Show it working: steps (where it clicks, what it types) and borrowing the cursor go to the Sidekick live;
          // a small picture of the window follows each step, so a window behind others can still be watched.
          const id = ctx?.toolCallId;
          let peekWin = null, peekBusy = false, peekAgain = false, peekN = 0;
          const peek = async () => {
            if (!id || !peekWin) return;
            if (peekBusy) { peekAgain = true; return; }
            peekBusy = true;
            try {
              const f = path.join(os.tmpdir(), `sidekick-peek-${process.pid}-${++peekN}.jpg`);
              const r = await hands('capture', f, `window:${peekWin}`, '640').catch(() => null);
              if (r?.ok !== false && existsSync(f)) {
                ui({ kind: 'agent', e: { type: 'act_peek', id, src: `data:image/jpeg;base64,${(await fs.readFile(f)).toString('base64')}`, window: r?.window } });
                fs.unlink(f).catch(() => {});
              }
            } finally { peekBusy = false; if (peekAgain) { peekAgain = false; peek(); } }
          };
          const onProgress = (ev) => {
            if (!id) return;
            if (ev.ev === 'start') { peekWin = ev.window?.id ?? null; ui({ kind: 'agent', e: { type: 'act_start', id, window: ev.window, steps: ev.steps } }); peek(); }
            else if (ev.ev === 'step') { ui({ kind: 'agent', e: { type: 'act_step', id, ...ev } }); setTimeout(peek, 350); }
            else if (ev.ev === 'borrow' || ev.ev === 'return') ui({ kind: 'agent', e: { type: `act_${ev.ev}`, id } });
          };
          const act = () => hands('act', JSON.stringify(plan), onProgress);
          let res;
          try {
            try { res = await act(); }
            catch (err) {
              // The app isn't open yet: open it (the same check as the open tool) and go on, instead of a round trip.
              if (plan.app && /No matching window/.test(String(err?.message ?? err)) && await launchApp(plan.app, hands)) { res = await act(); return finish(res); }
              // The window read earlier closed (a date picker or popup): use the app's front window instead.
              if (!plan.window || !/No matching window/.test(String(err?.message ?? err))) throw err;
              delete plan.window;
              if (asked !== 'front' && lastRead?.app) plan.app = lastRead.app;
              res = await act();
            }
          } finally {
            if (lastShot && mapped.some((s) => s.do !== 'wait')) lastShot.used = true;
            if (id) { await peek(); ui({ kind: 'agent', e: { type: 'act_end', id } }); }
          }
          return finish(res);
          function finish(res) {
            if (!res.controls) return `In ${res.window.app}: ${res.done.join(', ')}.`;
            lastRead = { win: res.window.id, app: res.window.app, controls: res.controls, turn };
            return `In ${res.window.app}: ${res.done.join(', ')}.\nNow showing: ${res.window.title || res.window.app}\n${controlList(res.controls, res.texts)}`;
          }
        },
      },
    ] : []),
    {
      name: 'read_file', description: 'Read a text file. Paths may start with ~. Files with passwords or keys (.ssh, .env, auth.json, keychains) are off limits.',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path: p }) => clip(await fs.readFile(allowed(checkRead(p, HOME)), 'utf8'), 60_000),
    },
    {
      name: 'list_files', description: 'List the files and folders in a directory.',
      parameters: z.object({ dir: z.string() }),
      execute: async ({ dir }) => {
        const ents = await fs.readdir(allowed(checkRead(dir, HOME)), { withFileTypes: true });
        return ents.slice(0, 300).map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n') + (ents.length > 300 ? `\n…and ${ents.length - 300} more` : '');
      },
    },
    {
      name: 'search_files', description: 'Search file contents under a specific folder for a text pattern (regex). Not your whole home folder: that trips macOS privacy prompts. To find files by name anywhere, use run_command with mdfind.',
      parameters: z.object({ pattern: z.string(), dir: z.string() }),
      execute: async ({ pattern, dir }) => {
        const d = allowed(checkRead(dir, HOME, { recursive: true }));
        // -e and -- keep a pattern like "--pre=cmd" from being read as an option (rg --pre runs programs).
        let r = await run('rg', ['-n', '--max-count', '5', '--max-columns', '200', '-e', pattern, '--', d]);
        if (r.err?.code === 'ENOENT') r = await run('grep', ['-rnI', '-m', '5', '-E', '-e', pattern, '--', d]);
        return clip(r.stdout || 'No matches.', 12_000);
      },
    },
    {
      name: 'write_file', description: 'Create or overwrite a text file with the given content (missing folders are made). Use this, not run_command, to create or change files: a new file needs no yes from the user; overwriting asks them. Several new files: one write_file call each, all in the same turn (a shell loop that makes files has to ask).',
      parameters: z.object({ path: z.string(), content: z.string() }), executionMode: 'sequential',
      execute: async ({ path: p, content }, ctx) => {
        if (!allowActions()) throw new Error(actionsOff);
        const exists = await fs.stat(expand(p)).then(() => true, () => false);
        const v = checkWrite(p, HOME, { exists });
        const f = allowed(v);
        if (v.level === ASK && !(await confirm(`${v.reason} Type y to let me.`, ctx))) throw new Error(`${userName} said no, so I didn't write ${p}.`);
        await fs.mkdir(path.dirname(f), { recursive: true });
        await fs.writeFile(f, content);
        return `Wrote ${content.length} characters to ${f}.`;
      },
    },
    {
      name: 'run_command', description: "Run a shell command in the user's home folder and return its output. Use it for what the other tools can't do (counting, sorting, wc, mdfind, git, moving or copying); to open a file, folder, app or link use the open tool, which needs no yes. Prefer write_file for creating or editing files (several files: one write_file call each, in the same turn); never edit with sed -i or tee, and never make files in a shell loop (for/while), which always needs a yes. A > redirect into a new file is fine; overwriting an existing file, and commands that change things, make the user confirm first, which is slow.",
      parameters: z.object({ command: z.string() }), executionMode: 'sequential', timeoutMs: 190_000, // up to 2 min to answer, then the 60 s run
      execute: async ({ command }, ctx) => {
        if (!allowActions()) throw new Error(actionsOff);
        const v = classifyCommand(command, HOME, { exists: existsSync });
        if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason} Don't try to get around this; tell ${userName} what you wanted to do instead.`);
        if (v.level === ASK && !(await confirm(`Run \`${command.length > 70 ? command.slice(0, 67) + '…' : command}\`?${v.reason ? ' ' + v.reason : ''} Type y to run it.`, ctx))) {
          throw new Error(`${userName} said no, so the command didn't run.`);
        }
        const shell = process.platform === 'win32' ? ['cmd', ['/c', command]] : [process.env.SHELL || '/bin/zsh', ['-lc', command]];
        const r = await run(shell[0], shell[1], { cwd: HOME });
        const out = clip((r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trim() || '(no output)', 12_000);
        if (r.err && r.err.code !== 0) throw new Error(`Exit ${r.err.code ?? r.err.signal}\n${out}`);
        return out;
      },
    },
    {
      name: 'fetch_url', description: 'Fetch a web page and return its readable text.',
      parameters: z.object({ url: z.string() }), // no .url(): OpenAI strict schemas reject format "uri"; checkUrl validates
      execute: async ({ url }) => {
        // Redirects are followed by hand so each hop is checked too (a public page can't bounce to localhost).
        let res, at = url;
        for (let hop = 0; ; hop++) {
          allowed(checkUrl(at));
          res = await fetch(at, { headers: { 'user-agent': 'Roamies-Sidekick' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
          const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
          if (!next) break;
          if (hop >= 5) throw new Error('Too many redirects.');
          at = new URL(next, at).href;
        }
        url = at;
        const html = await res.text();
        const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        return clip(`${res.status} ${url}\n${text}`, 15_000);
      },
    },
    {
      name: 'open', description: 'Open a website, a file or folder, or a Mac app by name (e.g. "Safari", "https://skool.com", "~/Documents"). Links open in the default browser; set app to open one in a particular browser or app (e.g. app "Safari" when the user says "in Safari").',
      parameters: z.object({ target: z.string(), app: z.string().optional() }),
      execute: async ({ target, app }) => {
        let t = String(target).trim();
        // A bare web address ("example.com", "www.bbc.co.uk/news") is a link, not an app name: it used to fail as
        // "Unable to find application named example.com" and cost a retry. App bundles ("Notes.app") stay apps.
        if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(t) && !/\.app$/i.test(t)) t = `https://${t}`;
        const isFile = /^[~/.]/.test(t) && await fs.stat(expand(t)).then((s) => s.isFile() && (s.mode & 0o111) !== 0, () => false);
        allowed(checkOpen(t, HOME, { executable: isFile }));
        // mailto: has no //, but it's a link too (it used to be taken for an app name and fail).
        const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^mailto:/i.test(t), isPath = /^[~/.]/.test(t) || /^[a-z]:\\/i.test(t);
        let r;
        const inApp = app && process.platform === 'darwin' && (isUrl || isPath) ? ['-a', String(app)] : [];
        if (process.platform === 'darwin') r = await run('open', isUrl || isPath ? [...inApp, isPath ? expand(t) : t] : ['-a', t]);
        else if (process.platform === 'win32') r = await winOpen(isPath ? expand(t) : t);
        else r = await run('xdg-open', [isPath ? expand(t) : t]);
        // Not installed: say so plainly, so the model doesn't go hunting for it with scripts (which need a yes each).
        if (r.err && /Unable to find application/i.test(r.stderr)) throw new Error(`There's no app called "${inApp.length ? app : t}" on this Mac (not installed, or it has another name). Don't look for it another way; tell ${userName} and carry on with the rest.`);
        if (r.err) throw new Error(r.stderr.trim() || `Couldn't open ${t}.`);
        if (lastShot) lastShot.used = true;
        return `Opened ${t}${inApp.length ? ` in ${app}` : ''}.`;
      },
    },
    {
      name: 'remember_commitment',
      description: `Save something ${userName} has committed to doing, or anything they ask to be reminded about, so you can remind them at the right moment. Use it whenever they say they will do something or say "remind me". kind: 'reminder' for a plain "remind me to X at/in …" (it clears itself once the nudge is given), 'commitment' (default) for something they say they'll do or finish ("I'll finish the slides by Friday"), which stays open until they say it's done. due: a relative time like "in 90s", "in 5m", "in 1h30m" or "in 2 days" (best for short timers), or a local time YYYY-MM-DDTHH:mm:ss, YYYY-MM-DDTHH:mm, or YYYY-MM-DD if only the day is known; omit if there's no time at all. Resolve words like "Thursday", "at 2" or "tonight" from the timestamp on their message.`,
      parameters: z.object({ text: z.string().min(2).max(200), due: z.string().optional(), kind: z.enum(['reminder', 'commitment']).optional() }),
      execute: async ({ text, due, kind }) => {
        const ms = parseDue(due);
        if (ms === undefined) throw new Error(`Couldn't read the time "${due}". Use YYYY-MM-DDTHH:mm or YYYY-MM-DD.`);
        // A plain reminder with no time has nothing to fire, so it's kept like a commitment.
        const c = await addCommitment(text, ms, ms ? kind : 'commitment');
        onCommitments(c);
        return `Saved as ${c.id}${ms ? `, due ${fmtWhen(ms)}` : ''}. I'll remind them${ms ? ' when it is due' : ''}.`;
      },
    },
    {
      name: 'update_commitment',
      description: 'Mark a saved commitment done or dropped, or change its due time (same format as remember_commitment; use "none" to clear it).',
      parameters: z.object({ id: z.string(), status: z.enum(['open', 'done', 'dropped']).optional(), due: z.string().optional() }),
      execute: async ({ id, status, due }) => {
        const ms = due === undefined ? undefined : due === 'none' ? null : parseDue(due);
        if (ms === undefined && due !== undefined) throw new Error(`Couldn't read the time "${due}".`);
        const c = await updateCommitment(id, { status, dueMs: ms });
        if (!c) throw new Error(`No commitment with id ${id}. Call list_commitments to see the ids.`);
        onCommitments(c);
        return `${c.id} is now ${c.status}${c.due ? `, due ${fmtWhen(c.due)}` : ''}.`;
      },
    },
    {
      name: 'remember_fact',
      description: `Save a lasting fact about ${userName} worth knowing in every future conversation: preferences, their projects, channels and tools, people they mention, how they like to work. Not passing small talk, and not commitments (those go to remember_commitment). One short fact per call.`,
      parameters: z.object({ fact: z.string().min(3).max(240) }),
      execute: async ({ fact }) => { const f = await addFact(fact); return `Remembered (${f.id}).`; },
    },
    {
      name: 'forget_fact', description: 'Delete a saved fact that is wrong or that the user asks you to forget. Ids are in the memory list in your instructions.',
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => { const f = await forgetFact(id); if (!f) throw new Error(`No fact with id ${id}.`); return `Forgot: ${f.text}`; },
    },
    {
      // The step trail on screen. Free to call: always alongside other tool calls, never in a turn of its own.
      name: 'plan_steps',
      description: 'Shows the user a checklist of the parts of a request with 3 or more separate parts (do x, then y, then z). First call: steps, a few words each, in order, in the same turn as your first action. After that, in the same turn as the tool calls that do a part, call it with now: [that part\'s number(s), from 1]; it ticks off by itself when those calls succeed. A part you skip or can\'t do: skipped: [{step, why}], why in a few plain words, in the same turn as your next tool call. Never call it in a turn on its own, and never for one- or two-part requests.',
      parameters: z.object({
        steps: z.array(z.string()).min(2).max(8).optional(),
        now: z.array(z.number().int()).optional(),
        skipped: z.array(z.object({ step: z.number().int(), why: z.string() })).optional(),
      }),
      execute: async (args) => { onPlan(args); return 'ok'; },
    },
    {
      name: 'show_list', description: "Show the user their list on screen (reminders and commitments, Today and Later). Use when they ask to see their list, to-dos or reminders; then answer in a few words, don't read it all out.",
      parameters: z.object({}),
      execute: async () => { showList(); return 'The list is on screen.'; },
    },
    {
      name: 'list_commitments', description: "List the open commitments you're keeping track of.",
      parameters: z.object({}),
      execute: async () => commitmentsText() || 'Nothing open.',
    },
  ];

  return { tools, hands, pointWaits, nextTurn: () => ++turn };
}
