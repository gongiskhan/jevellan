/* Jevellan website: theme, language, copy buttons, bathymetric contours, the hero route,
   the app mock-up, the Jev decision window and the take-the-helm demo. No dependencies.

   Page content lives inside #app. The published site has one page per language (/ and /pt/).
   The single-file preview swaps #app between two <template>s instead (window.JV_PREVIEW). */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SVGNS = 'http://www.w3.org/2000/svg';

  function lang() { return /^pt/i.test(root.getAttribute('lang') || '') ? 'pt' : 'en'; }

  /* ---------------- strings used by scripts ---------------- */
  var STR = {
    en: {
      dayWatch: 'Day watch', nightWatch: 'Night watch',
      toNight: 'Switch to night watch (dark theme)', toDay: 'Switch to day watch (light theme)',
      copy: 'Copy', copied: 'Copied', selectIt: 'Select it', menu: 'Menu', close: 'Close',
      yourRequest: 'Your request', landfall: 'landfall', verifiedPublished: 'verified, published',
      state: 'state', qa: 'questions &#8594; answers', keep: 'keep', sw: 'switch',
      noStretch: 'No stretch needed. Jevellan runs the tests itself on the final commit, then publishes to main.',
      jevFoot: 'example values · two calls · a few hundred ms', nextSituation: 'Next situation',
      rows: { request: 'request', last: 'last', facts: 'facts', current: 'current' },
      h: {
        done: 'done', running: 'running', reset: 'reset, saved at an undo ref', stopped: 'stopped', redoing: 'redoing',
        stillRunning: 'still running', next: 'next', jevDecides: 'Jev decides at the handoff', undone: 'Undone',
        corrected: 'corrected: Opus &#8594; Fable, high &#8594; max', change: 'Change this step',
        pick: 'Pick one. Either way, nothing waits for you.',
        undoNotice: 'Undid steps 2 to 3 and redid step 2 with Fable · max. It carries on by itself.',
        noteNotice: 'Recorded. Next decisions will read: &#8220;When implementing a UI change in jevellan-site, Jevellan chose Opus at high; the user changed it to Fable at max.&#8221;'
      }
    },
    pt: {
      dayWatch: 'Vigia de dia', nightWatch: 'Vigia da noite',
      toNight: 'Mudar para a vigia da noite (tema escuro)', toDay: 'Mudar para a vigia de dia (tema claro)',
      copy: 'Copiar', copied: 'Copiado', selectIt: 'Selecione', menu: 'Menu', close: 'Fechar',
      yourRequest: 'O seu pedido', landfall: 'terra à vista', verifiedPublished: 'verificado, publicado',
      state: 'estado', qa: 'perguntas &#8594; respostas', keep: 'manter', sw: 'trocar',
      noStretch: 'Não é preciso nenhum stretch. O Jevellan corre os testes no commit final e depois publica na main.',
      jevFoot: 'valores de exemplo · duas chamadas · algumas centenas de ms', nextSituation: 'Próxima situação',
      rows: { request: 'pedido', last: 'último', facts: 'factos', current: 'atual' },
      h: {
        done: 'concluído', running: 'a correr', reset: 'revertido, guardado numa ref de undo', stopped: 'parado', redoing: 'a refazer',
        stillRunning: 'continua a correr', next: 'a seguir', jevDecides: 'O Jev decide no handoff', undone: 'Desfeito',
        corrected: 'corrigido: Opus &#8594; Fable, high &#8594; max', change: 'Alterar este passo',
        pick: 'Escolha uma. Em qualquer dos casos, nada fica à sua espera.',
        undoNotice: 'Desfez os passos 2 e 3 e refez o passo 2 com Fable · max. Depois continua sozinho.',
        noteNotice: 'Registado. As próximas decisões vão ler: &#8220;Ao implementar uma alteração de interface no jevellan-site, o Jevellan escolheu Opus em high; o utilizador mudou para Fable em max.&#8221;'
      }
    }
  };
  function T() { return STR[lang()]; }

  function el(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function h(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function flagSvg(letter, cls) { return '<svg class="flag ' + (cls || '') + '" aria-hidden="true"><use href="#flag-' + letter + '"/></svg>'; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function closest(node, sel) { while (node && node.nodeType === 1) { if (node.matches(sel)) return node; node = node.parentNode; } return null; }

  /* ---------------- theme ---------------- */
  var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function isDark() {
    var t = root.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(mqDark && mqDark.matches);
  }
  function syncThemeButton() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    var dark = isDark(), t = T();
    var label = btn.querySelector('.tt-label');
    if (label) label.textContent = dark ? t.nightWatch : t.dayWatch;
    btn.setAttribute('aria-label', dark ? t.toDay : t.toNight);
    var use = btn.querySelector('use');
    if (use) use.setAttribute('href', dark ? '#i-moon' : '#i-lantern');
  }

  /* ---------------- bathymetric contours (simplex noise + marching squares) ---------------- */
  function makeNoise(seed) {
    var perm = [], p = new Uint8Array(512), i, s = (seed * 9973 + 1) % 2147483647;
    for (i = 0; i < 256; i++) perm[i] = i;
    for (i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; var r = s % (i + 1); var t = perm[i]; perm[i] = perm[r]; perm[r] = t; }
    for (i = 0; i < 512; i++) p[i] = perm[i & 255];
    var g = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
    var F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
    return function (xin, yin) {
      var sk = (xin + yin) * F2, ii = Math.floor(xin + sk), jj = Math.floor(yin + sk);
      var t0 = (ii + jj) * G2, x0 = xin - (ii - t0), y0 = yin - (jj - t0);
      var i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
      var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      var a = ii & 255, b = jj & 255;
      var g0 = g[p[a + p[b]] & 7], g1 = g[p[a + i1 + p[b + j1]] & 7], g2 = g[p[a + 1 + p[b + 1]] & 7];
      var n0 = 0, n1 = 0, n2 = 0, tt;
      tt = 0.5 - x0 * x0 - y0 * y0; if (tt > 0) { tt *= tt; n0 = tt * tt * (g0[0] * x0 + g0[1] * y0); }
      tt = 0.5 - x1 * x1 - y1 * y1; if (tt > 0) { tt *= tt; n1 = tt * tt * (g1[0] * x1 + g1[1] * y1); }
      tt = 0.5 - x2 * x2 - y2 * y2; if (tt > 0) { tt *= tt; n2 = tt * tt * (g2[0] * x2 + g2[1] * y2); }
      return 70 * (n0 + n1 + n2);
    };
  }
  var CASES = { 1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['T', 'R']], 5: [['T', 'R'], ['L', 'B']], 6: [['T', 'B']], 7: [['T', 'L']], 8: [['T', 'L']], 9: [['T', 'B']], 10: [['T', 'L'], ['B', 'R']], 11: [['T', 'R']], 12: [['L', 'R']], 13: [['B', 'R']], 14: [['L', 'B']] };
  function drawContours(canvas) {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width)), hgt = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    var seed = +canvas.getAttribute('data-seed') || 7, freq = +canvas.getAttribute('data-freq') || 380;
    var noise = makeNoise(seed);
    var cell = w < 600 ? 9 : 11;
    var nx = Math.ceil(w / cell) + 1, ny = Math.ceil(hgt / cell) + 1;
    var f = new Float32Array(nx * ny), x, y;
    for (y = 0; y < ny; y++) for (x = 0; x < nx; x++) {
      var px = x * cell / freq, py = y * cell / freq;
      f[y * nx + x] = noise(px, py) * 0.66 + noise(px * 2.1 + 5.2, py * 2.1 + 1.3) * 0.24 + noise(px * 4.3 + 9.1, py * 4.3 + 3.7) * 0.1;
    }
    var cs = getComputedStyle(canvas);
    var cNorm = cs.getPropertyValue('--contour').trim() || 'rgba(44,110,155,.2)';
    var cStrong = cs.getPropertyValue('--contour-strong').trim() || 'rgba(44,110,155,.34)';
    for (var li = -8; li <= 8; li++) {
      var L = li * 0.085;
      ctx.beginPath();
      for (y = 0; y < ny - 1; y++) for (x = 0; x < nx - 1; x++) {
        var a = f[y * nx + x], b = f[y * nx + x + 1], c = f[(y + 1) * nx + x + 1], d = f[(y + 1) * nx + x];
        var idx = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
        var segs = CASES[idx];
        if (!segs) continue;
        var x0 = x * cell, y0 = y * cell;
        for (var si = 0; si < segs.length; si++) {
          for (var k = 0; k < 2; k++) {
            var e = segs[si][k], ex, ey;
            if (e === 'T') { ex = x0 + cell * (L - a) / (b - a); ey = y0; }
            else if (e === 'R') { ex = x0 + cell; ey = y0 + cell * (L - b) / (c - b); }
            else if (e === 'B') { ex = x0 + cell * (L - d) / (c - d); ey = y0 + cell; }
            else { ex = x0; ey = y0 + cell * (L - a) / (d - a); }
            if (k === 0) ctx.moveTo(ex, ey); else ctx.lineTo(ex, ey);
          }
        }
      }
      ctx.strokeStyle = (li % 4 === 0) ? cStrong : cNorm;
      ctx.lineWidth = (li % 4 === 0) ? 1.15 : 0.8;
      ctx.stroke();
    }
  }
  function drawAllContours() {
    Array.prototype.forEach.call(document.querySelectorAll('canvas.contours'), function (c) { try { drawContours(c); } catch { /* decorative */ } });
  }

  /* ---------------- the example passage on the hero chart ---------------- */
  var PASSAGE = [
    { flag: 'P', act: 'plan', model: 'Opus', effort: 'high' },
    { flag: 'I', act: 'implement', model: 'Fable', effort: 'max' },
    { flag: 'T', act: 'test', model: 'Fable', effort: 'medium' },
    { flag: 'R', act: 'review', model: 'GPT-6', effort: 'high' },
    { flag: 'I', act: 'implement', model: 'Fable', effort: 'high' }
  ];
  var LAYOUTS = {
    wide: {
      W: 640, H: 600,
      pts: [[88, 546], [160, 452], [270, 488], [340, 346], [450, 384], [520, 236], [570, 120]],
      place: ['below', 'above', 'below', 'above', 'below', 'above', 'left'],
      lands: [
        'M22,580 C18,556 44,540 72,544 C92,547 104,560 100,578 C96,596 74,604 50,602 C34,600 24,592 22,580 Z',
        'M574,100 C572,80 592,66 614,68 C632,70 642,84 638,102 C634,120 616,130 596,128 C582,126 575,114 574,100 Z'
      ],
      rose: [566, 516, 44],
      soundings: [[210, 180, '18'], [120, 300, '24'], [410, 520, '31'], [300, 150, '27'], [500, 330, '42'], [70, 160, '15'], [250, 575, '9'], [390, 250, '22']],
      grid: { xs: [80, 240, 400, 560], ys: [120, 300, 480], xl: ['9°30′W', '9°20′W', '9°10′W', '9°00′W'], yl: ['38°50′N', '38°40′N', '38°30′N'] }
    },
    narrow: {
      W: 360, H: 690,
      pts: [[84, 50], [262, 140], [100, 234], [266, 330], [100, 424], [262, 518], [158, 632]],
      place: ['right', 'left', 'right', 'left', 'right', 'left', 'above'],
      lands: [
        'M10,44 C8,22 30,10 54,14 C74,18 84,32 78,48 C72,64 50,70 32,66 C18,62 11,54 10,44 Z',
        'M152,650 C158,630 188,622 216,628 C242,634 254,652 246,670 C238,686 208,692 182,686 C162,682 148,666 152,650 Z'
      ],
      rose: [306, 58, 32],
      soundings: [[200, 230, '18'], [180, 420, '24'], [60, 330, '31'], [310, 420, '27'], [44, 560, '12'], [320, 250, '40']],
      grid: { xs: [60, 180, 300], ys: [120, 300, 480], xl: ['9°20′W', '9°10′W', '9°00′W'], yl: ['38°50′N', '38°40′N', '38°30′N'] }
    }
  };
  function smoothPath(pts) {
    var d = 'M' + pts[0][0] + ',' + pts[0][1];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ' C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ',' + c2y.toFixed(1) + ' ' + p2[0] + ',' + p2[1];
    }
    return d;
  }
  var routeAnim = null;
  function buildRoute(container) {
    if (routeAnim) { cancelAnimationFrame(routeAnim.raf); routeAnim = null; }
    if (!container) return;
    var variant = container.clientWidth >= 500 ? 'wide' : 'narrow';
    var Lr = LAYOUTS[variant], t = T();
    container.innerHTML = '';
    container.setAttribute('data-variant', variant);
    var svg = el('svg', { viewBox: '0 0 ' + Lr.W + ' ' + Lr.H, 'aria-hidden': 'true', focusable: 'false' });
    container.appendChild(svg);

    var g = el('g', {}, svg);
    Lr.grid.xs.forEach(function (x, i) { el('line', { class: 'grid-line', x1: x, y1: 0, x2: x, y2: Lr.H }, g); var tx = el('text', { class: 'grid-label', x: x + 4, y: 12 }, g); tx.textContent = Lr.grid.xl[i]; });
    Lr.grid.ys.forEach(function (y, i) { el('line', { class: 'grid-line', x1: 0, y1: y, x2: Lr.W, y2: y }, g); var tx = el('text', { class: 'grid-label', x: 4, y: y - 4 }, g); tx.textContent = Lr.grid.yl[i]; });
    var rose = Lr.rose, rg = el('g', {}, svg);
    for (var a = 0; a < 16; a++) {
      var ang = a * Math.PI / 8, len = Math.max(Lr.W, Lr.H) * 1.5;
      el('line', { class: 'rhumb', x1: rose[0], y1: rose[1], x2: (rose[0] + Math.cos(ang) * len).toFixed(1), y2: (rose[1] + Math.sin(ang) * len).toFixed(1) }, rg);
    }
    Lr.lands.forEach(function (d) { el('path', { class: 'land', d: d }, svg); });
    Lr.soundings.forEach(function (s) { var tx = el('text', { class: 'sounding', x: s[0], y: s[1] }, svg); tx.textContent = s[2]; });
    var rr = rose[2], ro = el('g', { transform: 'translate(' + rose[0] + ',' + rose[1] + ')' }, svg);
    el('circle', { class: 'rose-ring', r: rr }, ro);
    el('circle', { class: 'rose-ring', r: rr * 0.78 }, ro);
    for (var tk = 0; tk < 32; tk++) {
      var ta = tk * Math.PI / 16, r1 = rr * (tk % 4 === 0 ? 0.86 : 0.93);
      el('line', { class: 'rose-ring', x1: (Math.cos(ta) * r1).toFixed(1), y1: (Math.sin(ta) * r1).toFixed(1), x2: (Math.cos(ta) * rr).toFixed(1), y2: (Math.sin(ta) * rr).toFixed(1) }, ro);
    }
    var s1 = rr * 0.72, s2 = rr * 0.16;
    el('path', { class: 'rose-star light', d: 'M0,' + (-s1) + ' L' + s2 + ',0 L0,' + s1 + ' L' + (-s2) + ',0 Z' }, ro);
    el('path', { class: 'rose-star light', d: 'M' + (-s1) + ',0 L0,' + s2 + ' L' + s1 + ',0 L0,' + (-s2) + ' Z' }, ro);
    el('path', { class: 'rose-star', d: 'M0,' + (-s1) + ' L' + s2 + ',0 L0,0 Z M0,' + s1 + ' L' + (-s2) + ',0 L0,0 Z M' + s1 + ',0 L0,' + s2 + ' L0,0 Z M' + (-s1) + ',0 L0,' + (-s2) + ' L0,0 Z' }, ro);
    var nt = el('text', { class: 'rose-n', x: 0, y: -rr - 6, 'text-anchor': 'middle' }, ro); nt.textContent = 'N';

    var d = smoothPath(Lr.pts);
    el('path', { class: 'course-shadow', d: d }, svg);
    var course = el('path', { class: 'course' + (reduceMotion ? '' : ' flow'), d: d }, svg);
    var pts = Lr.pts, pulses = [];
    el('circle', { class: 'port-ring', cx: pts[0][0], cy: pts[0][1], r: 9 }, svg);
    el('circle', { class: 'port', cx: pts[0][0], cy: pts[0][1], r: 4.5 }, svg);
    for (var i = 1; i < pts.length; i++) {
      pulses.push(el('circle', { class: 'wpt-pulse', cx: pts[i][0], cy: pts[i][1], r: 8 }, svg));
      el('circle', { class: 'wpt-ring', cx: pts[i][0], cy: pts[i][1], r: 7.5 }, svg);
      el('circle', { class: 'wpt-dot', cx: pts[i][0], cy: pts[i][1], r: 3.2 }, svg);
    }
    el('circle', { class: 'port-ring', cx: pts[pts.length - 1][0], cy: pts[pts.length - 1][1], r: 12, style: 'stroke:var(--ok)' }, svg);

    var ship = el('g', { class: 'ship' }, svg);
    el('circle', { class: 'ship-glow', cx: 0, cy: -2, r: 12 }, ship);
    var shipBody = el('g', {}, ship);
    el('path', { class: 'ship-hull', d: 'M-12,2 H12 L9,7 H-9 Z' }, shipBody);
    el('path', { class: 'ship-sail', d: 'M1,1 V-15 C6,-11 8,-5 8,1 Z' }, shipBody);
    el('path', { class: 'ship-sail', d: 'M-1,1 V-12 L-8,1 Z' }, shipBody);
    el('line', { x1: 0, y1: -15, x2: 0, y2: -21, style: 'stroke:var(--ink);stroke-width:1' }, shipBody);
    el('use', { href: '#flag-PT', x: 0, y: -22, width: 9, height: 6 }, shipBody);
    el('circle', { class: 'ship-lamp', cx: -10, cy: -1, r: 2 }, shipBody);

    var labels = h('div', 'route-labels');
    container.appendChild(labels);
    function pos(node, x, y, place) {
      var off = 14;
      if (place === 'above') y -= off; else if (place === 'below') y += off; else if (place === 'left') x -= off; else if (place === 'right') x += off;
      node.style.left = (x / Lr.W * 100) + '%';
      node.style.top = (y / Lr.H * 100) + '%';
      node.classList.add(place);
    }
    var start = h('div', 'wlabel port-label', esc(t.yourRequest));
    pos(start, pts[0][0], pts[0][1], variant === 'wide' ? 'below' : 'right');
    labels.appendChild(start);
    PASSAGE.forEach(function (s, idx) {
      var lab = h('div', 'wlabel', flagSvg(s.flag) + '<span class="act">' + s.act + '</span><span class="sep">·</span><span class="mdl">' + s.model + '</span><span class="sep">·</span><span>' + s.effort + '</span>');
      pos(lab, pts[idx + 1][0], pts[idx + 1][1], Lr.place[idx + 1]);
      labels.appendChild(lab);
    });
    var land = h('div', 'wlabel landfall', flagSvg('C') + '<span class="ok">' + esc(t.landfall) + '</span><span class="sep">·</span><span>' + esc(t.verifiedPublished) + '</span>');
    pos(land, pts[pts.length - 1][0], pts[pts.length - 1][1], Lr.place[pts.length - 1]);
    labels.appendChild(land);

    var total = course.getTotalLength(), wptLen = [];
    (function () {
      var steps = 400, best = pts.map(function () { return { d: 1e9, l: 0 }; });
      for (var sI = 0; sI <= steps; sI++) {
        var l = total * sI / steps, p = course.getPointAtLength(l);
        for (var k = 1; k < pts.length; k++) {
          var dx = p.x - pts[k][0], dy = p.y - pts[k][1], dd = dx * dx + dy * dy;
          if (dd < best[k].d) best[k] = { d: dd, l: l };
        }
      }
      for (var k2 = 1; k2 < pts.length; k2++) wptLen.push(best[k2].l);
    })();
    function placeShip(l) {
      var p = course.getPointAtLength(Math.max(0, Math.min(total, l)));
      var p2 = course.getPointAtLength(Math.max(0, Math.min(total, l + 2)));
      var flip = p2.x < p.x ? -1 : 1;
      ship.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + (p.y - 4).toFixed(1) + ')');
      shipBody.setAttribute('transform', 'scale(' + flip + ',1)');
    }
    if (reduceMotion) { placeShip(total); return; }
    var DUR = 15000, HOLD = 2200, t0 = null, fired = {};
    routeAnim = { raf: 0 };
    function frame(ts) {
      if (!container.isConnected) return;
      if (t0 === null) t0 = ts;
      var tt = (ts - t0) % (DUR + HOLD);
      var prog = Math.min(1, tt / DUR);
      var eased = prog < 0.5 ? 2 * prog * prog : 1 - Math.pow(-2 * prog + 2, 2) / 2;
      var l = eased * total;
      placeShip(l);
      if (tt < 60) fired = {};
      for (var k = 0; k < wptLen.length; k++) {
        if (!fired[k] && l >= wptLen[k] - 1) {
          fired[k] = true;
          var pu = pulses[k];
          pu.classList.remove('on'); void pu.getBBox(); pu.classList.add('on');
        }
      }
      routeAnim.raf = requestAnimationFrame(frame);
    }
    routeAnim.raf = requestAnimationFrame(frame);
  }

  /* ---------------- the Jev window ---------------- */
  var SCENES = {
    en: [
      { name: 'after a plan', state: { request: '"Add a dark mode to the settings page and save the choice per user"', last: 'plan · done · "Toggle, theme tokens, a user_prefs column, tests"', facts: 'no code changed yet · UI work · tests exist', current: 'Opus · high' }, verdict: 'implement · Fable · max' },
      { name: 'after the implementation', state: { request: '"Add a dark mode to the settings page and save the choice per user"', last: 'implement · done · 6 files changed', facts: 'medium change · stored data touched · not verified yet', current: 'Fable · max' }, verdict: 'test · Fable (kept) · medium' },
      { name: 'after a review with one serious finding', state: { request: '"Add a dark mode to the settings page and save the choice per user"', last: 'review · done · 1 serious: choice lost on sign-out', facts: '1 review so far · tests passing', current: 'GPT-6 · high' }, verdict: 'implement · Fable · high' },
      { name: 'a quick question', state: { request: '"What does useTheme() return?"', last: 'none, new work', facts: 'first decision · nothing changed', current: 'Fable · high' }, verdict: 'reply · Opus · low' },
      { name: 'the fix is in, tests pass', state: { request: '"Add a dark mode to the settings page and save the choice per user"', last: 'implement · done · fix plus a sign-out test', facts: 'tests passing · review cap reached', current: 'Fable · high' }, verdict: 'done' }
    ],
    pt: [
      { name: 'depois de um plano', state: { request: '"Adicione um modo escuro à página de definições e guarde a escolha por utilizador"', last: 'plan · done · "Interruptor, tokens de tema, uma coluna user_prefs, testes"', facts: 'ainda sem alterações ao código · trabalho de interface · há testes', current: 'Opus · high' }, verdict: 'implement · Fable · max' },
      { name: 'depois da implementação', state: { request: '"Adicione um modo escuro à página de definições e guarde a escolha por utilizador"', last: 'implement · done · 6 ficheiros alterados', facts: 'alteração média · dados guardados alterados · ainda não verificado', current: 'Fable · max' }, verdict: 'test · Fable (mantido) · medium' },
      { name: 'depois de uma revisão com um problema grave', state: { request: '"Adicione um modo escuro à página de definições e guarde a escolha por utilizador"', last: 'review · done · 1 grave: a escolha perde-se ao terminar a sessão', facts: '1 revisão até agora · testes a passar', current: 'GPT-6 · high' }, verdict: 'implement · Fable · high' },
      { name: 'uma pergunta rápida', state: { request: '"O que devolve o useTheme()?"', last: 'nenhum, trabalho novo', facts: 'primeira decisão · nada alterado', current: 'Fable · high' }, verdict: 'reply · Opus · low' },
      { name: 'a correção entrou, os testes passam', state: { request: '"Adicione um modo escuro à página de definições e guarde a escolha por utilizador"', last: 'implement · done · correção e um teste de fim de sessão', facts: 'testes a passar · limite de revisões atingido', current: 'Fable · high' }, verdict: 'done' }
    ]
  };
  var ANSWERS = [
    { next: [['implement', 0.81], ['test', 0.07], ['ask-you', 0.06], ['plan', 0.04], ['reply', 0.02]], keep: { p: 0.22, label: 'Opus' }, model: [['Fable', 0.74], ['Opus', 0.18], ['GPT-6', 0.08]], effort: [['max', 0.61], ['xhigh', 0.27], ['high', 0.12]] },
    { next: [['test', 0.72], ['review', 0.14], ['implement', 0.09], ['done', 0.05]], keep: { p: 0.83, label: 'Fable' }, model: null, effort: [['medium', 0.58], ['high', 0.30], ['low', 0.12]] },
    { next: [['implement', 0.77], ['ask-you', 0.09], ['test', 0.08], ['done', 0.06]], keep: { p: 0.12, label: 'GPT-6' }, model: [['Fable', 0.64], ['GPT-6', 0.22], ['Opus', 0.14]], effort: [['high', 0.64], ['xhigh', 0.20], ['medium', 0.16]] },
    { next: [['reply', 0.91], ['plan', 0.04], ['implement', 0.03], ['ask-you', 0.02]], keep: { p: 0.34, label: 'Fable' }, model: [['Opus', 0.69], ['Fable', 0.20], ['GPT-6', 0.11]], effort: [['low', 0.70], ['medium', 0.24], ['high', 0.06]] },
    { next: [['done', 0.86], ['test', 0.10], ['ask-you', 0.04]], keep: null, model: null, effort: null, nostretch: true }
  ];
  var sceneIdx = 0;
  function barsHtml(list, animate) {
    var max = 0; list.forEach(function (b) { if (b[1] > max) max = b[1]; });
    return '<div class="bars">' + list.map(function (b) {
      return '<div class="bar' + (b[1] === max ? ' win' : '') + '" style="--p:' + (animate ? 0 : b[1]) + '" data-p="' + b[1] + '"><span class="lbl">' + esc(b[0]) + '</span><span class="track"><span class="fill"></span></span><span class="val">' + b[1].toFixed(2) + '</span></div>';
    }).join('') + '</div>';
  }
  function renderScene(animate) {
    var body = document.getElementById('jev-body');
    if (!body) return;
    var t = T(), sc = SCENES[lang()][sceneIdx], an = ANSWERS[sceneIdx];
    var html = '<div class="jev-section-label">' + t.state + ': ' + esc(sc.name) + '</div>';
    html += '<dl class="jev-state">' + ['request', 'last', 'facts', 'current'].map(function (k) {
      var v = esc(sc.state[k]);
      if (k === 'request') v = '<span class="str">' + v + '</span>';
      return '<dt>' + t.rows[k] + '</dt><dd>' + v + '</dd>';
    }).join('') + '</dl>';
    html += '<div class="jev-section-label">' + t.qa + '</div>';
    html += '<div class="jev-q"><div class="jev-q-head"><span class="jev-q-key">next_action</span><span class="qtype">Choice</span><span class="jev-q-verdict">' + esc(an.next[0][0]) + '</span></div>' + barsHtml(an.next, animate) + '</div>';
    if (an.nostretch) {
      html += '<div class="jev-nostretch">' + t.noStretch + '</div>';
    } else {
      if (an.keep) {
        var kept = an.keep.p >= 0.6;
        html += '<div class="jev-q"><div class="jev-q-head"><span class="jev-q-key">keep_current</span><span class="qtype">Noul</span><span class="jev-q-verdict">' + (kept ? t.keep + ' ' + esc(an.keep.label) : t.sw) + '</span></div>' +
          '<div class="noul"><span class="track"><span class="fill" style="--p:' + (animate ? 0 : an.keep.p) + '" data-p="' + an.keep.p + '"></span><span class="thr" style="--t:.6" data-label="0.6"></span></span><span class="val" style="font-variant-numeric:tabular-nums;color:var(--jev);font-weight:700">' + an.keep.p.toFixed(2) + '</span></div></div>';
      }
      if (an.model) html += '<div class="jev-q"><div class="jev-q-head"><span class="jev-q-key">pick_model</span><span class="qtype">Choice</span><span class="jev-q-verdict">' + esc(an.model[0][0]) + '</span></div>' + barsHtml(an.model, animate) + '</div>';
      if (an.effort) html += '<div class="jev-q"><div class="jev-q-head"><span class="jev-q-key">effort</span><span class="qtype">Choice</span><span class="jev-q-verdict">' + esc(an.effort[0][0]) + '</span></div>' + barsHtml(an.effort, animate) + '</div>';
    }
    html += '<div class="jev-foot"><span class="meta">&#9656; ' + esc(sc.verdict) + '<br>' + t.jevFoot + '</span><button class="jev-next" type="button" id="jev-next">' + t.nextSituation + ' &#8635;</button></div>';
    body.innerHTML = html;
    var count = document.getElementById('jev-scene-count');
    if (count) count.textContent = (sceneIdx + 1) + '/' + ANSWERS.length;
    if (animate) {
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        body.querySelectorAll('[data-p]').forEach(function (n) { n.style.setProperty('--p', n.getAttribute('data-p')); });
      }); });
    }
  }

  /* ---------------- take the helm ---------------- */
  var helmMode = 'initial';
  function stepHtml(s) {
    var t = T().h;
    if (s.ghost) return '<div class="step ghost"><div class="s-top"><span class="s-n">' + s.n + '</span><span class="s-act">' + t.next + '</span></div><span class="s-status">' + t.jevDecides + '</span></div>';
    var click = s.clickModel ? ' clickable" role="button" tabindex="0" data-helm-open="1" title="' + t.change + '"' : '"';
    return '<div class="step' + (s.cls ? ' ' + s.cls : '') + '"><div class="s-top">' + flagSvg(s.flag) + '<span class="s-n">' + s.n + '</span><span class="s-act">' + s.act + '</span></div>' +
      '<div class="s-chips"><span class="s-chip' + click + '>' + s.model + '</span><span class="s-chip' + click + '>' + s.effort + '</span></div>' +
      '<span class="s-status' + (s.running ? ' run' : '') + '">' + s.status + '</span><span class="undone-tag">' + t.undone + '</span><span class="corrected-tag">' + t.corrected + '</span></div>';
  }
  function renderHelm() {
    var wrap = document.getElementById('helm-steps');
    if (!wrap) return;
    var pop = document.getElementById('helm-pop'), notice = document.getElementById('helm-notice'), t = T().h, steps;
    if (helmMode === 'initial') {
      steps = [
        { n: '1', flag: 'P', act: 'plan', model: 'Opus', effort: 'high', status: t.done },
        { n: '2', flag: 'I', act: 'implement', model: 'Opus', effort: 'high', status: t.done, clickModel: true },
        { n: '3', flag: 'T', act: 'test', model: 'Opus', effort: 'medium', status: t.running, running: true },
        { n: '4', ghost: true }
      ];
      pop.hidden = false;
      notice.className = 'demo-notice';
      notice.innerHTML = t.pick;
    } else if (helmMode === 'undo') {
      steps = [
        { n: '1', flag: 'P', act: 'plan', model: 'Opus', effort: 'high', status: t.done },
        { n: '2', flag: 'I', act: 'implement', model: 'Opus', effort: 'high', status: t.reset, cls: 'undone' },
        { n: '3', flag: 'T', act: 'test', model: 'Opus', effort: 'medium', status: t.stopped, cls: 'undone' },
        { n: '2′', flag: 'S', act: 'implement', model: 'Fable', effort: 'max', status: t.redoing, running: true, cls: 'redo' }
      ];
      pop.hidden = true;
      notice.className = 'demo-notice good';
      notice.innerHTML = flagSvg('S') + '<span>' + t.undoNotice + '</span>';
    } else {
      steps = [
        { n: '1', flag: 'P', act: 'plan', model: 'Opus', effort: 'high', status: t.done },
        { n: '2', flag: 'I', act: 'implement', model: 'Opus', effort: 'high', status: t.done, cls: 'corrected' },
        { n: '3', flag: 'T', act: 'test', model: 'Opus', effort: 'medium', status: t.stillRunning, running: true },
        { n: '4', ghost: true }
      ];
      pop.hidden = true;
      notice.className = 'demo-notice good';
      notice.innerHTML = '<span>' + t.noteNotice + '</span>';
    }
    wrap.innerHTML = steps.map(stepHtml).join('');
  }

  /* ---------------- the app mock-up ---------------- */
  function mockShowWhy(mock, id, open) {
    var panes = mock.querySelectorAll('.m-why-pane');
    var label = '';
    Array.prototype.forEach.call(panes, function (p) {
      var on = p.getAttribute('data-why') === id;
      p.hidden = !on;
      if (on) label = p.getAttribute('data-label') || '';
    });
    var lab = mock.querySelector('.m-why-label');
    if (lab) lab.textContent = label;
    Array.prototype.forEach.call(mock.querySelectorAll('.m-stretch'), function (s) { s.classList.toggle('sel', s.getAttribute('data-s') === id); });
    mock.classList.remove('no-why');
    if (open) mock.classList.add('why-open');
  }
  function mockShowConv(mock, id) {
    Array.prototype.forEach.call(mock.querySelectorAll('.m-conv'), function (c) { c.hidden = c.getAttribute('data-conv') !== id; });
    Array.prototype.forEach.call(mock.querySelectorAll('.m-list li'), function (li) { li.classList.toggle('on', li.getAttribute('data-conv') === id); });
    var first = mock.querySelector('.m-conv[data-conv="' + id + '"] .m-stretch');
    var sel = mock.querySelector('.m-conv[data-conv="' + id + '"] .m-stretch.sel') || first;
    if (sel) mockShowWhy(mock, sel.getAttribute('data-s'), false);
    mock.classList.remove('side-open');
  }
  function onMockClick(e, mock) {
    var tgt = e.target;
    var li = closest(tgt, '.m-list li');
    if (li) { if (li.getAttribute('data-conv')) mockShowConv(mock, li.getAttribute('data-conv')); return; }
    var f = closest(tgt, '.m-filters button');
    if (f) {
      var want = f.getAttribute('data-f');
      Array.prototype.forEach.call(mock.querySelectorAll('.m-filters button'), function (b) { b.classList.toggle('on', b === f); });
      Array.prototype.forEach.call(mock.querySelectorAll('.m-list li'), function (x) { x.hidden = !(want === 'all' || x.getAttribute('data-state') === want); });
      return;
    }
    var why = closest(tgt, '.m-why-btn');
    if (why) { mockShowWhy(mock, why.getAttribute('data-why'), true); return; }
    if (closest(tgt, '.m-why-close')) { mock.classList.remove('why-open'); if (window.innerWidth > 1020) mock.classList.add('no-why'); return; }
    var sw = closest(tgt, '.m-switch');
    var menu = mock.querySelector('.m-devmenu');
    if (sw && menu) { menu.hidden = !menu.hidden; sw.setAttribute('aria-expanded', String(!menu.hidden)); return; }
    if (menu && !menu.hidden && !closest(tgt, '.m-devmenu')) { menu.hidden = true; }
    if (closest(tgt, '.m-menu')) { mock.classList.add('side-open'); return; }
    if (closest(tgt, '.m-close-side')) { mock.classList.remove('side-open'); return; }
  }

  /* ---------------- one delegated click handler for everything ---------------- */
  document.addEventListener('click', function (e) {
    var tgt = e.target;

    var setLang = closest(tgt, '[data-setlang]');
    if (setLang) {
      var lg = setLang.getAttribute('data-setlang');
      try { localStorage.setItem('jv-lang', lg); } catch { /* storage may be unavailable */ }
      if (window.JV_PREVIEW) { e.preventDefault(); swapLang(lg); }
      return;
    }
    if (closest(tgt, '#theme-toggle')) {
      var next = isDark() ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('jv-theme', next); } catch { /* storage may be unavailable */ }
      return;
    }
    var menuBtn = closest(tgt, '#menu-btn');
    var mobileNav = document.getElementById('mobile-nav');
    if (menuBtn && mobileNav) {
      var open = mobileNav.hidden;
      mobileNav.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.textContent = open ? T().close : T().menu;
      return;
    }
    if (mobileNav && !mobileNav.hidden && closest(tgt, '#mobile-nav a')) {
      mobileNav.hidden = true;
      var mb = document.getElementById('menu-btn');
      if (mb) { mb.setAttribute('aria-expanded', 'false'); mb.textContent = T().menu; }
    }
    var copyBtn = closest(tgt, '[data-copy]');
    if (copyBtn) {
      var text = copyBtn.getAttribute('data-copy'), t = T();
      var done = function (ok) {
        copyBtn.textContent = ok ? t.copied : t.selectIt;
        copyBtn.classList.toggle('copied', ok);
        setTimeout(function () { copyBtn.textContent = t.copy; copyBtn.classList.remove('copied'); }, 1600);
      };
      var selectFallback = function () {
        var code = copyBtn.parentElement.querySelector('code');
        if (code) { var r = document.createRange(); r.selectNodeContents(code); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
        done(false);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, selectFallback);
        else selectFallback();
      } catch { selectFallback(); }
      return;
    }
    if (closest(tgt, '#jev-next')) { sceneIdx = (sceneIdx + 1) % ANSWERS.length; renderScene(!reduceMotion); return; }
    if (closest(tgt, '#helm-undo')) { helmMode = 'undo'; renderHelm(); return; }
    if (closest(tgt, '#helm-just')) { helmMode = 'noted'; renderHelm(); return; }
    if (closest(tgt, '#helm-reset') || closest(tgt, '[data-helm-open]')) { helmMode = 'initial'; renderHelm(); var u = document.getElementById('helm-undo'); if (u && closest(tgt, '[data-helm-open]')) u.focus(); return; }
    var mock = closest(tgt, '#mock');
    if (mock) onMockClick(e, mock);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var nav = document.getElementById('mobile-nav');
      var menu = document.getElementById('menu-btn');
      if (nav && menu && !nav.hidden) {
        nav.hidden = true;
        menu.setAttribute('aria-expanded', 'false');
        menu.textContent = T().menu;
        menu.focus();
      }
      var mock = document.getElementById('mock');
      if (mock && mock.classList.contains('side-open')) {
        mock.classList.remove('side-open');
        mock.querySelector('.m-menu').focus();
      } else if (mock && mock.classList.contains('why-open')) {
        mock.classList.remove('why-open');
        var why = mock.querySelector('.m-stretch.sel .m-why-btn');
        if (why) why.focus();
      }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var n = closest(e.target, '[data-helm-open], .m-list li[data-conv]');
    if (n) { e.preventDefault(); n.click(); }
  });

  /* ---------------- nav: highlight the section in view ---------------- */
  var navIO = null;
  function watchNav() {
    if (navIO) navIO.disconnect();
    var links = Array.prototype.slice.call(document.querySelectorAll('.nav a'));
    if (!('IntersectionObserver' in window) || !links.length) return;
    var byId = {};
    links.forEach(function (a) { var id = (a.getAttribute('href') || '').replace(/^#/, ''); if (id) byId[id] = a; });
    navIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var a = byId[en.target.id];
        if (a && en.isIntersecting) { links.forEach(function (x) { x.removeAttribute('aria-current'); }); a.setAttribute('aria-current', 'true'); }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(byId).forEach(function (id) { var s = document.getElementById(id); if (s) navIO.observe(s); });
  }

  /* ---------------- language swap (single-file preview only) ---------------- */
  function swapLang(lg) {
    var tpl = document.getElementById('tpl-' + lg), app = document.getElementById('app');
    if (!tpl || !app) return;
    root.setAttribute('lang', lg === 'pt' ? 'pt-PT' : 'en');
    app.innerHTML = tpl.innerHTML;
    sceneIdx = 0; helmMode = 'initial';
    mount();
  }

  /* ---------------- mount: everything bound to the current #app content ---------------- */
  function mount() {
    syncThemeButton();
    buildRoute(document.getElementById('hero-route'));
    renderScene(false);
    renderHelm();
    drawAllContours();
    watchNav();
  }

  /* ---------------- once ---------------- */
  new MutationObserver(function () { syncThemeButton(); drawAllContours(); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  if (mqDark && mqDark.addEventListener) mqDark.addEventListener('change', function () { syncThemeButton(); drawAllContours(); });
  var lastW = window.innerWidth, rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      drawAllContours();
      if (Math.abs(window.innerWidth - lastW) > 2) { lastW = window.innerWidth; buildRoute(document.getElementById('hero-route')); }
    }, 160);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { drawAllContours(); });

  if (window.JV_PREVIEW) {
    var want = 'en';
    try {
      var p = localStorage.getItem('jv-lang');
      var nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
      if (p === 'pt' || (!p && /^pt/i.test(nav))) want = 'pt';
    } catch { /* storage may be unavailable */ }
    if (want === 'pt') { swapLang('pt'); return; }
  }
  mount();
})();
