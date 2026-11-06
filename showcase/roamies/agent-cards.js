// Cards beside the Sidekick while it works, drawn on its LED grid with the same chrome as its list (rounded LED
// frame, dark glass, glint), the same dot-matrix text and glow, and the list's tick rings and the chip's spinner.
//  - peek: a live view of the window it's working in (often hidden behind the user's own), with its own LED cursor
//    moving to what it clicks, what it types, and a heads-up when it has to borrow the real mouse.
//  - trail: the parts of a "do this, then that" request, ticking off as each finishes; a skipped part says why.
// API on agent.cards: peekStart(e) peekStep(e) peekImage(src, win) borrow(on) peekEnd(ok) trail(e)
(() => {
  const R = window.Roamie;
  const { clamp } = R;

  // Dot-matrix glyphs, built the same way as the bubbles' (Menlo bold on a 6x10 cell, two brightness levels).
  const CW = 6, CH = 10, SS = 4, glyphs = new Map();
  let gcan = null, gctx = null;
  const glyph = (ch) => {
    let g = glyphs.get(ch);
    if (g) return g;
    if (!gcan) { gcan = document.createElement('canvas'); gcan.width = CW * SS; gcan.height = CH * SS; gctx = gcan.getContext('2d', { willReadFrequently: true }); }
    gctx.clearRect(0, 0, gcan.width, gcan.height);
    gctx.fillStyle = '#fff'; gctx.textAlign = 'center'; gctx.textBaseline = 'alphabetic';
    gctx.font = `700 ${9 * SS}px Menlo, "SF Mono", ui-monospace, monospace`;
    gctx.fillText(ch, 2.5 * SS, 8 * SS);
    const px = gctx.getImageData(0, 0, gcan.width, gcan.height).data, pts = [];
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW - 1; x++) {
      let a = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) a += px[((y * SS + j) * gcan.width + x * SS + i) * 4 + 3];
      a /= SS * SS * 255;
      if (a > 0.5) pts.push(x, y, 2); else if (a > 0.26) pts.push(x, y, 1);
    }
    glyphs.set(ch, pts);
    return pts;
  };
  const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
  const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  // The bubbles' text size: one dot per t px.
  const Tsz = (k) => clamp(k.P * 0.42, 1.4, 2.4);

  // Text into paths: bright dots into a[0], soft edge dots into a[1]. upto: characters typed in so far.
  const dotText = (a, s, x, y, t, upto = Infinity) => {
    for (let j = 0; j < s.length && j < upto; j++) {
      if (s[j] === ' ') continue;
      const gl = glyph(s[j]);
      for (let q = 0; q < gl.length; q += 3) (gl[q + 2] === 2 ? a[0] : a[1]).rect(x + (j * CW + gl[q]) * t, y + gl[q + 1] * t, t * 0.82, t * 0.82);
    }
  };
  const paths = () => ({ hot: [new Path2D(), new Path2D()], dim: [new Path2D(), new Path2D()] });
  // Painted like the list's text: hot text glows, dim text doesn't.
  const flush = (ctx, k, p, alpha) => {
    const { PAL, L } = k, t = Tsz(k);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = css(PAL[L - 1], 0.7); ctx.shadowBlur = t * 3;
    ctx.fillStyle = css(PAL[L]); ctx.fill(p.hot[0]);
    ctx.fillStyle = css(PAL[L - 1], 0.75); ctx.fill(p.hot[1]);
    ctx.shadowBlur = 0;
    ctx.fillStyle = css(PAL[L - 2], 0.95); ctx.fill(p.dim[0]);
    ctx.fillStyle = css(PAL[L - 2], 0.6); ctx.fill(p.dim[1]);
    ctx.restore();
  };

  // The list's chrome: rounded LED frame, dark glass, a glint on the top edge, dissolving in through the dither.
  const frame = (k, x0, y0, x1, y1, fade, edge) => {
    const { PAL, L, th, setPx } = k, DARK = PAL[0], EDGE = edge ?? PAL[Math.max(1, L - 2)], RIM = PAL[L - 1], cr = 2;
    const inside = (x, y, grow) => {
      const dx = Math.max(x0 + cr - x, 0, x - (x1 - cr)), dy = Math.max(y0 + cr - y, 0, y - (y1 - cr));
      return dx * dx + dy * dy <= (cr + grow) * (cr + grow);
    };
    for (let gy = y0 - 2; gy <= y1 + 2; gy++) for (let gx = x0 - 2; gx <= x1 + 2; gx++) {
      if (th(gx, gy) >= fade) continue;
      if (inside(gx, gy, 0)) setPx(gx, gy, gy - y0 < 1 && gx - x0 > 2 && gx - x0 < 6 ? RIM : DARK, 235, true);
      else if (inside(gx, gy, 1)) setPx(gx, gy, EDGE, 255);
    }
  };
  const ring = (k, bx, by, n, lvl) => { for (let i = 0; i < n; i++) { k.put(bx + i, by, lvl); k.put(bx + i, by + n - 1, lvl); k.put(bx, by + i, lvl); k.put(bx + n - 1, by + i, lvl); } };
  const check = (k, bx, by, n, lvl) => {
    const bot = by + n - 2, pivot = bx + Math.floor((n - 1) / 2);
    for (let x = bx + 1; x <= pivot; x++) k.put(x, bot - (pivot - x), lvl);
    for (let x = pivot + 1; x <= bx + n - 2; x++) k.put(x, bot - (x - pivot), lvl);
  };
  // Skipped: a bare cross with no ring, so it never reads as a tick.
  const cross = (k, bx, by, n, lvl) => { for (let i = 0; i < n; i++) { k.put(bx + i, by + i, lvl); k.put(bx + n - 1 - i, by + i, lvl); } };
  // The tool chip's spinner: eight dots with a lit head chasing round.
  const spinner = (k, cx, cy, now) => {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, lit = (Math.floor(now * 14) - i + 80) % 8;
      k.put(cx + Math.round(Math.cos(a) * 1.6), cy + Math.round(Math.sin(a) * 1.6), lit < 3 ? k.L - lit : 1);
    }
  };
  // The guide's stepped LED frame with a soft glow, around a rect in px.
  const stepFrame = (ctx, k, x0, y0, w, h, alpha) => {
    const P = Math.max(2, k.P * 0.6), c = P * 2, col = (a) => css(k.PAL[k.L], a);
    ctx.save();
    ctx.shadowColor = col(0.9 * alpha); ctx.shadowBlur = 10; ctx.strokeStyle = col(0.95 * alpha); ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0 + c, y0); ctx.lineTo(x0 + w - c, y0); ctx.lineTo(x0 + w - c, y0 + P); ctx.lineTo(x0 + w, y0 + P); ctx.lineTo(x0 + w, y0 + c);
    ctx.lineTo(x0 + w, y0 + h - c); ctx.lineTo(x0 + w, y0 + h - P); ctx.lineTo(x0 + w - c, y0 + h - P); ctx.lineTo(x0 + w - c, y0 + h);
    ctx.lineTo(x0 + c, y0 + h); ctx.lineTo(x0 + c, y0 + h - P); ctx.lineTo(x0, y0 + h - P); ctx.lineTo(x0, y0 + h - c);
    ctx.lineTo(x0, y0 + c); ctx.lineTo(x0, y0 + P); ctx.lineTo(x0 + c, y0 + P); ctx.closePath();
    ctx.stroke(); ctx.shadowBlur = 0; ctx.fillStyle = col(0.08 * alpha); ctx.fill();
    ctx.restore();
  };
  // Its own cursor: an LED arrow (dark outline, lit body), drawn in px with the grid's dot gaps.
  const ARROW = ['X.........', 'XX........', 'X#X.......', 'X##X......', 'X###X.....', 'X####X....', 'X#####X...', 'X######X..', 'X###XXXXX.', 'X#X#X.....', 'XX.X#X....', 'X...X#X...', '.....XX...'];
  const arrow = (ctx, k, ax, ay, s, alpha) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = css(k.PAL[k.L - 1], 0.8); ctx.shadowBlur = 6;
    ARROW.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return;
      ctx.fillStyle = ch === 'X' ? css(k.PAL[k.L]) : css(k.PAL[0]);
      ctx.fillRect(ax + x * s, ay + y * s, s * 0.84, s * 0.84);
    }));
    ctx.restore();
  };

  // ---------- a card beside the Sidekick: placed and sprung like its list, fading through the dither ----------
  class Card {
    constructor() { this.open = false; this.age = 0; this.closing = 0; this.until = Infinity; this.x = { x: 0, v: 0 }; this.y = { x: 0, v: 0 }; this.placed = false; this.geo = null; }
    show(k) { if (!this.open || this.closing) { this.open = true; this.closing = 0; this.age = 0; this.placed = false; k.S('page'); } this.until = Infinity; }
    close(k, after = 0) { this.until = Math.min(this.until, now() + after); }
    fade() { return this.closing ? clamp(1 - this.closing / 0.3, 0, 1) : clamp(this.age / 0.22, 0, 1); }
    update(dt, k, side, slot) {
      if (!this.open) return;
      if (this.closing) { this.closing += dt; if (this.closing > 0.35) { this.open = false; this.closing = 0; } }
      else { this.age += dt; if (now() > this.until) { this.closing = 0.0001; k.S('poof'); } }
      const { w, h } = this.size(k), P = k.P, S = R.safe ?? { left: 0, top: 0, right: 0, bottom: 0 }, m = k.m;
      const l = S.left, t = S.top, r = innerWidth - S.right, b = innerHeight - S.bottom, wpx = w * P, hpx = h * P, gap = k.R * 1.35 + P * 3;
      let tx = side === 'right' ? m.x + gap : m.x - gap - wpx, ty = m.y - hpx / 2 + slot;
      if (tx < l + P * 2 || tx + wpx > r - P * 2) { tx = m.x - wpx / 2; ty = m.y - k.R * 1.4 - hpx - P * 4 - Math.abs(slot); if (ty < t + P * 2) ty = m.y + k.R * 1.4 + P * 4 + Math.abs(slot); }
      tx = clamp(tx, l + P * 2, Math.max(l + P * 2, r - wpx - P * 2)); ty = clamp(ty, t + P * 2, Math.max(t + P * 2, b - hpx - P * 2));
      const spring = (s, target) => { s.v += ((target - s.x) * 70 - s.v * 11) * dt; s.x += s.v * dt; };
      if (!this.placed) { this.x.x = tx; this.y.x = ty; this.placed = true; }
      spring(this.x, tx); spring(this.y, ty);
      const x0 = Math.round(this.x.x / P), y0 = Math.round(this.y.x / P);
      this.geo = { P, w, h, x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 };
    }
  }
  const now = () => performance.now() / 1000;

  // ---------- peek: a live view of the window it's working in ----------
  class Peek extends Card {
    start(e, k) {
      this.show(k);
      this.win = e.window ?? null; this.total = e.steps ?? 0; this.i = -1; this.cap = `Looking at ${this.win?.app ?? 'the window'}`;
      this.typed = null; this.hl = null; this.rip = 0; this.cur = null; this.borrowing = 0; this.back = 0; this.end = null; this.img = null; this.cam = null;
      this.title = clip(`${(this.win?.app ?? '').toUpperCase()}${this.win?.title ? ` · ${this.win.title}` : ''}`, 40);
    }
    image(src, win, k) {
      const img = new Image();
      img.onload = () => { this.img = img; if (win?.bounds) this.win = { ...this.win, ...win }; };
      img.src = src;
    }
    step(e, k) {
      if (!this.open) this.start({ window: this.win, steps: this.total }, k);
      this.i = e.i ?? this.i + 1; this.end = null;
      const label = e.label ? clip(e.label, 28) : '';
      const what = {
        click_text: `Clicking "${label}"`, click: `Clicking ${label || 'it'}`, press_button: `Pressing ${label || 'it'}`, focus: `Clicking ${label || 'the field'}`,
        fill: `${label || 'Field'}: `, set: `${label || 'Field'}: `, type: 'Typing ', choose: `Choosing ${clip(e.text ?? '', 26)}`,
        key: `Pressing ${label}`, scroll: `Scrolling ${label}`, click_at: 'Clicking there',
      }[e.do] ?? 'Working';
      this.cap = what;
      this.typed = ['fill', 'set', 'type'].includes(e.do) && e.text ? { text: e.text, at: now() } : null;
      if (e.bounds && this.win?.bounds) {
        this.hl = e.bounds;
        const c = this.center(e.bounds), from = this.cur ? this.curAt() : c;
        this.cur = { from, to: c, at: now() };
        if (/click|press|focus|choose|fill|set/.test(e.do)) this.rip = now() + 0.5;
      } else this.hl = null;
      k.S('pip');
    }
    borrow(on, k) { if (on) { this.borrowing = now(); this.back = 0; k.S('remind'); } else { this.borrowing = 0; this.back = now(); } }
    finish(ok, k) { this.end = { ok, at: now() }; this.hl = null; this.typed = null; this.borrowing = 0; this.close(k, ok ? 2.4 : 3.2); }
    center(b) { return [b[0] + b[2] / 2, b[1] + b[3] / 2]; }
    curAt() { const c = this.cur, u = ease(clamp((now() - c.at) / 0.5, 0, 1)); return [c.from[0] + (c.to[0] - c.from[0]) * u, c.from[1] + (c.to[1] - c.from[1]) * u]; }
    size(k) {
      const P = k.P, t = Tsz(k), rowC = Math.ceil((CH * t + P * 1.6) / P), w = Math.round(clamp(innerWidth * 0.2, 250, 330) / P);
      const asp = this.img ? clamp(this.img.naturalHeight / this.img.naturalWidth, 0.45, 0.8) : 0.6;
      this.rowC = rowC; this.vh = Math.round(((w - 6) * asp));
      return { w, h: 6 + rowC * 2 + 2 + this.vh };
    }
    grid(k) {
      if (!this.open || !this.geo) return;
      const g = this.geo, f = this.fade(), ip = 3;
      // While it has the real mouse, the frame lights up and pulses so the user knows to keep hands off.
      const hot = this.borrowing && Math.sin(now() * 8) > -0.2;
      frame(k, g.x0, g.y0, g.x1, g.y1, f, hot ? k.PAL[k.L] : undefined);
      if (f < 1) return;
      const vx0 = g.x0 + ip - 1, vy0 = g.y0 + ip + this.rowC, vx1 = g.x1 - ip + 1, vy1 = vy0 + this.vh + 1;
      for (let x = vx0; x <= vx1; x++) { k.put(x, vy0, 1); k.put(x, vy1, 1); }
      for (let y = vy0; y <= vy1; y++) { k.put(vx0, y, 1); k.put(vx1, y, 1); }
      const by = vy1 + 2 + Math.floor((this.rowC - 5) / 2), bx = g.x0 + ip;
      if (this.end?.ok) { ring(k, bx, by, 5, k.L - 1); check(k, bx, by, 5, k.L); }
      else if (this.end) cross(k, bx, by, 5, k.L);
      else if (this.borrowing) for (let i = 0; i < 3; i++) k.put(bx + i * 2, by + 2, Math.floor(now() * 4) % 3 >= i ? k.L : 1);
      else spinner(k, bx + 2, vy1 + 2 + Math.floor(this.rowC / 2), now());
    }
    text(ctx, k) {
      if (!this.open || !this.geo) return;
      const g = this.geo, P = g.P, t = Tsz(k), ip = 3, f = this.fade(), p = paths();
      const rowY = (row) => row + (this.rowC * P - CH * t) / 2;
      const cols = Math.floor(((g.w - ip * 2) * P) / (CW * t));
      const stepTxt = this.total > 1 && this.i >= 0 ? `${Math.min(this.i + 1, this.total)}/${this.total}` : '';
      dotText(p.dim, clip(this.title, cols - stepTxt.length - 2), (g.x0 + ip) * P, rowY((g.y0 + ip) * P), t);
      if (stepTxt) dotText(p.hot, stepTxt, (g.x1 - ip + 1) * P - stepTxt.length * CW * t, rowY((g.y0 + ip) * P), t);
      const vx = (g.x0 + ip) * P, vy = (g.y0 + ip + this.rowC + 1) * P, vw = (g.w - ip * 2) * P, vh = this.vh * P;
      // Caption: what it's doing now, typing in letter by letter; or the heads-up while it has the mouse.
      let cap = this.cap, upto = Infinity;
      if (this.end) cap = this.end.ok ? 'Done' : "That didn't work";
      else if (this.borrowing) cap = 'Borrowing your mouse…';
      else if (this.back && now() - this.back < 1.4) cap = 'Mouse is yours again';
      else if (this.typed) { const full = this.cap + this.typed.text; upto = this.cap.length + Math.floor((now() - this.typed.at) * 18); cap = full; }
      const capCols = cols - 3;
      if (cap.length > capCols) { const shown = Math.min(upto, cap.length); const start = Math.max(0, shown - capCols); cap = cap.slice(start, start + capCols); upto = Math.max(0, upto - start); }
      dotText(p.hot, cap, vx + 7 * P, rowY(vy + vh + P * 2), t, upto);
      ctx.save();
      ctx.globalAlpha = f;
      ctx.beginPath(); ctx.rect(vx, vy, vw, vh); ctx.clip();
      const img = this.img, wb = this.win?.bounds;
      if (img?.complete && img.naturalWidth) {
        // Zoomed in on what it's working on (the whole window is too small to read in a card), panning smoothly
        // from one control to the next; the whole window while it's only looking.
        const IW = img.naturalWidth, IH = img.naturalHeight, kx = wb ? IW / wb[2] : 1, asp = vh / vw;
        let want = [0, 0, IW, Math.min(IH, IW * asp)];
        if (this.hl && wb) {
          const cx = (this.hl[0] - wb[0] + this.hl[2] / 2) * kx, cy = (this.hl[1] - wb[1] + this.hl[3] / 2) * kx;
          const cw = clamp(this.hl[2] * kx * 2, IW * 0.24, IW), ch = Math.min(IH, cw * asp);
          want = [clamp(cx - cw * 0.42, 0, IW - cw), clamp(cy - ch / 2, 0, IH - ch), cw, ch];
        }
        const cam = (this.cam ??= want.slice()), u = clamp((now() - (this.camAt ?? 0)) * 6, 0, 1);
        this.camAt = now();
        for (let q = 0; q < 4; q++) cam[q] += (want[q] - cam[q]) * (u * 0.35 + 0.05);
        // Panning draws straight from the once-tinted picture with the cached dot grid on top, so no frame rebuilds it.
        const crop = cam, ph = Math.min(vh, crop[3] * (vw / crop[2])), dpr = Math.min(2, window.devicePixelRatio || 1);
        const tint = R.ledTint(img, k), gaps = R.ledGaps(Math.round(vw * dpr), Math.round(vh * dpr), k);
        if (tint && ph >= 1) {
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(tint, crop[0], crop[1], crop[2], crop[3], vx, vy, vw, ph);
          ctx.drawImage(gaps, 0, 0, gaps.width, Math.round(ph * dpr), vx, vy, vw, ph);
        }
        if (wb) {
          const map = (x, y) => [vx + ((x - wb[0]) * kx - crop[0]) * (vw / crop[2]), vy + ((y - wb[1]) * kx - crop[1]) * (vw / crop[2])];
          if (this.hl && !this.end) {
            const [x, y] = map(this.hl[0], this.hl[1]), pu = 0.75 + 0.25 * Math.sin(now() * 6);
            const z = kx * (vw / crop[2]);
            stepFrame(ctx, k, x - 3, y - 3, this.hl[2] * z + 6, this.hl[3] * z + 6, pu);
          }
          if (this.cur) {
            const [cx, cy] = this.curAt(), [ax, ay] = map(cx, cy);
            if (this.rip && now() < this.rip) {
              const u = 1 - (this.rip - now()) / 0.5, s = 4 + u * 16;
              ctx.save(); ctx.strokeStyle = css(k.PAL[k.L], 1 - u); ctx.lineWidth = 2; ctx.strokeRect(ax - s / 2, ay - s / 2, s, s); ctx.restore();
            }
            arrow(ctx, k, ax, ay, Math.max(2.5, t * 1.45), this.end ? clamp(1 - (now() - this.end.at) / 0.6, 0, 1) : 1);
          }
        }
      } else {
        const q = paths(); dotText(q.dim, 'Looking…', vx + 8, vy + 8, t); flush(ctx, k, q, 1);
      }
      ctx.restore();
      flush(ctx, k, p, f);
    }
  }

  // ---------- trail: the parts of the request ----------
  class Trail extends Card {
    set(e, k) {
      const fresh = !this.open || this.closing;
      this.show(k);
      const before = this.steps ?? [];
      this.steps = (e.steps ?? []).map((s, i) => ({ ...s, at: before[i]?.state === s.state ? before[i].at : now() }));
      for (const [i, s] of this.steps.entries()) if (!fresh && before[i] && before[i].state !== s.state && (s.state === 'ok' || s.state === 'bad')) k.S(s.state === 'ok' ? 'tick' : 'error');
      this.head = e.head ?? 'YOUR REQUEST';
      if (e.final) this.close(k, 4.5);
    }
    rows(k) {
      // Text runs from the mark column to the frame's inner edge.
      const t = Tsz(k), P = k.P, w = this.cells(k), cols = Math.floor(((w - 3 * 2 - 8) * P) / (CW * t)), out = [];
      for (const [i, s] of (this.steps ?? []).entries()) {
        out.push({ i, text: clip(s.text, cols) });
        if (s.state === 'bad' && s.why) for (const line of wrapWords(s.why, cols)) out.push({ i, note: line });
      }
      return out;
    }
    size(k) {
      const P = k.P, t = Tsz(k);
      this.rowC = Math.ceil((CH * t + P * 1.6) / P);
      return { w: this.cells(k), h: 6 + this.rowC * (1 + this.rows(k).length) };
    }
    cells(k) { return Math.round(clamp(innerWidth * 0.22, 260, 340) / k.P); }
    grid(k) {
      if (!this.open || !this.geo) return;
      const g = this.geo, f = this.fade(), ip = 3;
      frame(k, g.x0, g.y0, g.x1, g.y1, f);
      if (f < 1) return;
      this.rows(k).forEach((r, n) => {
        if (r.note) return;
        const s = this.steps[r.i], ry = g.y0 + ip + (n + 1) * this.rowC, nb = 5, bx = g.x0 + ip, by = ry + Math.floor((this.rowC - nb) / 2);
        if (s.state === 'ok') { ring(k, bx, by, nb, k.L - 1); const fl = now() - s.at < 0.5; check(k, bx, by, nb, fl ? k.L : k.L - 1); }
        else if (s.state === 'bad') cross(k, bx, by, nb, k.L);
        else if (s.state === 'now') spinner(k, bx + 2, by + 2, now());
        else ring(k, bx, by, nb, 1);
      });
    }
    text(ctx, k) {
      if (!this.open || !this.geo) return;
      const g = this.geo, P = g.P, t = Tsz(k), ip = 3, p = paths();
      const rowY = (n) => (g.y0 + ip + n * this.rowC) * P + (this.rowC * P - CH * t) / 2;
      const done = (this.steps ?? []).filter((s) => s.state === 'ok' || s.state === 'bad').length;
      const count = `${done}/${this.steps?.length ?? 0}`;
      dotText(p.dim, clip(this.head, Math.floor(((g.w - ip * 2) * P) / (CW * t)) - count.length - 2), (g.x0 + ip) * P, rowY(0), t);
      dotText(p.hot, count, (g.x1 - ip + 1) * P - count.length * CW * t, rowY(0), t);
      this.rows(k).forEach((r, n) => {
        const s = this.steps[r.i], x = (g.x0 + ip + 8) * P;
        if (r.note) dotText(p.dim, r.note, x, rowY(n + 1), t);
        else dotText(s.state === 'now' || s.state === 'ok' || s.state === 'bad' ? p.hot : p.dim, r.text, x, rowY(n + 1), t);
      });
      flush(ctx, k, p, this.fade());
    }
  }
  const wrapWords = (s, cols) => {
    const out = []; let line = '';
    for (const w of String(s).split(/\s+/)) { if ((line + ' ' + w).trim().length > cols) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim(); }
    if (line) out.push(line);
    return out.slice(0, 3);
  };

  const orig = R.agentPlugin;
  R.agentPlugin = (k) => {
    const p = orig(k);
    if (!p) return p;
    const peek = new Peek(), trail = new Trail();
    const shown = () => k.presence === 'shown' || (k.presence === 'in' && k.presU > 0.72);
    const { gridOver, over, update } = p;
    p.gridOver = (env) => { gridOver(env); if (shown()) { peek.grid(k); trail.grid(k); } };
    p.over = (ctx, env) => { over(ctx, env); if (shown()) { peek.text(ctx, k); trail.text(ctx, k); } };
    p.update = (dt, env) => {
      update(dt, env);
      // The peek on the roomier side (away from a speech bubble beside it); the trail on the other, or above.
      const S = R.safe ?? { left: 0, right: 0 }, mid = (S.left + innerWidth - S.right) / 2;
      let side = k.m.x < mid ? 'right' : 'left';
      const bs = p.api?.bubble && !p.api.bubble.closing ? p.api.bubble.side : null;
      if (bs === side) side = side === 'right' ? 'left' : 'right';
      peek.update(dt, k, side, 0);
      trail.update(dt, k, peek.open ? (side === 'right' ? 'left' : 'right') : side, 0);
    };
    if (p.api) {
      const keep = () => p.api.show?.({ summoned: true });
      p.api.cards = {
        peekStart: (e) => { keep(); peek.start(e, k); },
        peekStep: (e) => peek.step(e, k),
        peekImage: (src, win) => peek.image(src, win, k),
        borrow: (on) => peek.borrow(on, k),
        peekEnd: (ok = true) => { if (peek.open) peek.finish(ok, k); },
        trail: (e) => { keep(); trail.set(e, k); },
        get open() { return peek.open || trail.open; },
      };
    }
    return p;
  };
})();
