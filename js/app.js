/* app.js — 验图页面逻辑（无外部依赖，浏览器全局 DxfCore / DxfWriter） */
(function () {
  'use strict';
  const C = window.DxfCore;

  /* ---------------- 状态 ---------------- */
  const state = {
    doc: null,
    model: null,
    fileName: '',
    overrides: {},          // occurrenceId -> {x,y,sx,sy,rotation}
    selectedId: null,
    selectedSeg: null,      // {entityLine, seg}
    reviews: [],
    showBounds: true,
    showDim: true,
    view: { scale: 2, offX: 0, offY: 0 },
    drag: null
  };

  /* ---------------- DOM ---------------- */
  const $ = (s) => document.querySelector(s);
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  const treeEl = $('#tree');
  const detailsEl = $('#details');
  const statsEl = $('#modelStats');
  const emptyState = $('#emptyState');
  const toastEl = $('#toast');

  let toastTimer = null;
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (kind ? ' ' + kind : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, kind === 'err' ? 6000 : 3000);
  }

  /* ---------------- 导入 ---------------- */
  function loadText(text, name) {
    try {
      const doc = C.parseDxf(text);
      state.doc = doc;
      state.fileName = name || '未命名.dxf';
      state.overrides = {};
      state.reviews = [];
      state.selectedId = null;
      state.selectedSeg = null;
      rebuild();
      toast('已导入 ' + state.fileName + '：' + state.model.leafCount +
        ' 个展开实体，' + state.model.occurrences.length + ' 个顶层实例', 'ok');
      $('#resetOverridesBtn').disabled = true;
      updateReviewUi();
      setTimeout(fitView, 30);
    } catch (e) {
      // 解析/展开被明确拒绝时，仅在页面内提示，不向控制台抛未捕获异常
      toast('拒绝导入：' + e.message, 'err');
    }
  }

  function rebuild() {
    state.model = C.buildModel(state.doc, state.overrides);
    // 选中实例可能因结构不变仍存在
    if (state.selectedId && !state.model.findOccurrence(state.selectedId)) {
      state.selectedId = null;
      state.selectedSeg = null;
    }
    emptyState.classList.add('hidden');
    renderTree();
    renderDetails();
    draw();
  }

  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => loadText(reader.result, f.name);
    reader.onerror = () => toast('文件读取失败', 'err');
    reader.readAsText(f);
    e.target.value = '';
  });

  // 拖放
  const vp = document.querySelector('.viewport');
  ['dragenter', 'dragover'].forEach(ev => vp.addEventListener(ev, (e) => {
    e.preventDefault(); $('#dropOverlay').hidden = false;
  }));
  ['dragleave', 'drop'].forEach(ev => vp.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.target !== canvas && e.target !== vp) return;
    $('#dropOverlay').hidden = true;
  }));
  vp.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => loadText(reader.result, f.name);
    reader.readAsText(f);
  });

  $('#loadSampleBtn').addEventListener('click', () => {
    const text = window.buildSampleDxf();
    loadText(text, 'sample-验图示例.dxf');
  });
  $('#emptySample').addEventListener('click', (e) => {
    e.preventDefault();
    $('#loadSampleBtn').click();
  });
  $('#resetOverridesBtn').addEventListener('click', () => {
    state.overrides = {};
    rebuild();
    $('#resetOverridesBtn').disabled = true;
    toast('已复位全部实例比例修改（共享块定义从未被修改）', 'ok');
  });

  /* ---------------- 坐标变换 ---------------- */
  function w2sX(x) { return x * state.view.scale + state.view.offX; }
  function w2sY(y) { return canvas.clientHeight - (y * state.view.scale + state.view.offY); }
  function s2wX(px) { return (px - state.view.offX) / state.view.scale; }
  function s2wY(py) { return (canvas.clientHeight - py - state.view.offY) / state.view.scale; }

  function fitView() {
    if (!state.model) return;
    const b = state.model.bounds;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!b.valid()) { state.view = { scale: 4, offX: w / 2, offY: h / 2 }; draw(); return; }
    const bw = Math.max(b.width(), 1e-6), bh = Math.max(b.height(), 1e-6);
    const pad = 46;
    const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    state.view.scale = s;
    state.view.offX = w / 2 - ((b.xmin + b.xmax) / 2) * s;
    state.view.offY = h / 2 - ((b.ymin + b.ymax) / 2) * s;
    updateZoomLabel();
    draw();
  }
  function zoomAt(cx, cy, factor) {
    const wx = s2wX(cx), wy = s2wY(cy);
    state.view.scale = Math.max(1e-4, Math.min(1e7, state.view.scale * factor));
    state.view.offX = cx - wx * state.view.scale;
    state.view.offY = cy - wy * state.view.scale;
    updateZoomLabel();
    draw();
  }
  // 基准：scale=2 px/世界单位 时显示 100%
  function updateZoomLabel() { $('#viewScale').textContent = '缩放 ' + Math.round(state.view.scale / 2 * 100) + '%'; }

  $('#zoomFit').addEventListener('click', fitView);
  $('#zoomIn').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.2));
  $('#zoomOut').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2));
  $('#toggleBounds').addEventListener('change', (e) => { state.showBounds = e.target.checked; draw(); });
  $('#toggleDim').addEventListener('change', (e) => { state.showDim = e.target.checked; draw(); });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  /* ---------------- 绘制 ---------------- */
  const COL = {
    grid: '#1a222c', axis: '#33445a',
    line: '#c9d6e4', arc: '#ffd166',
    selLine: '#ffb84e', selArc: '#ffd166',
    bounds: 'rgba(78,161,255,.95)', boundsFill: 'rgba(78,161,255,.07)',
    treeBox: 'rgba(255,184,78,.85)',
    endpoint: '#4ed18a', midpoint: '#ffd166', extreme: '#ff8af0',
    dim: '#9ecbff', other: '#556273'
  };

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const ro = new ResizeObserver(() => { resizeCanvas(); draw(); });
  ro.observe(canvas);

  function draw() {
    if (!state.model) { resizeCanvas(); return; }
    resizeCanvas();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    drawGrid(w, h);

    const selOcc = state.selectedId ? state.model.findOccurrence(state.selectedId) : null;
    const selSet = new Set();
    if (selOcc) collectPrims(selOcc, selSet);

    // 先画非选中（暗），再画选中（亮）
    state.model.primitives.forEach((p) => {
      if (!selSet.has(p)) drawPrimitive(p, false);
    });
    if (selOcc) {
      // 实例整体包围盒
      drawBoundsRect(selOcc.subTreeBounds, COL.treeBox, false, [6, 4]);
      selSet.forEach((p) => drawPrimitive(p, true));
    }

    // 选中段的量测标注
    if (selOcc && state.selectedSeg) {
      const pr = findPrim(selOcc, state.selectedSeg);
      if (pr) drawSegmentDimensions(pr);
    }
  }

  function collectPrims(occ, set) {
    occ.primitives.forEach((p) => set.add(p));
    occ.children.forEach((c) => collectPrims(c, set));
  }

  function drawGrid(w, h) {
    const s = state.view.scale;
    let step = 10;
    while (step * s < 26) step *= 5;
    const x0 = s2wX(0), y0 = s2wY(0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = COL.grid;
    ctx.beginPath();
    for (let gx = Math.floor(x0 / step) * step; gx <= s2wX(w); gx += step) {
      const px = w2sX(gx);
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
    }
    for (let gy = Math.floor(s2wY(h) / step) * step; gy <= y0; gy += step) {
      const py = w2sY(gy);
      ctx.moveTo(0, py); ctx.lineTo(w, py);
    }
    ctx.stroke();
    // 坐标轴
    ctx.strokeStyle = COL.axis;
    ctx.beginPath();
    ctx.moveTo(0, w2sY(0)); ctx.lineTo(w, w2sY(0));
    ctx.moveTo(w2sX(0), 0); ctx.lineTo(w2sX(0), h);
    ctx.stroke();
  }

  function drawPrimitive(p, highlighted) {
    ctx.lineJoin = 'round';
    if (p.type === 'line') {
      ctx.strokeStyle = highlighted ? COL.selLine : COL.line;
      ctx.lineWidth = highlighted ? 2.2 : 1.3;
      ctx.beginPath();
      ctx.moveTo(w2sX(p.a.x), w2sY(p.a.y));
      ctx.lineTo(w2sX(p.b.x), w2sY(p.b.y));
      ctx.stroke();
    } else {
      const pts = C.tessellateArc(p.arc, p.matrix);
      ctx.strokeStyle = highlighted ? COL.selArc : COL.arc;
      ctx.lineWidth = highlighted ? 2.4 : 1.5;
      ctx.beginPath();
      pts.forEach((q, i) => {
        const x = w2sX(q.x), y = w2sY(q.y);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      if (highlighted) drawArcArrow(p);
    }
  }

  function drawArcArrow(p) {
    const arc = p.arc, m = p.matrix;
    const t = arc.a0 + arc.sweep * 0.5;
    const c0 = C.matrix.apply(m, C.arcPointLocal(arc, t));
    const tv = C.matrix.applyVec(m, -arc.r * Math.sin(t), arc.r * Math.cos(t));
    const len = Math.hypot(tv.x, tv.y) || 1;
    const ux = tv.x / len, uy = tv.y / len;
    const size = 9;
    const bx = c0.x - ux * (size / state.view.scale), by = c0.y - uy * (size / state.view.scale);
    const nx = -uy, ny = ux;
    ctx.fillStyle = COL.selArc;
    ctx.beginPath();
    ctx.moveTo(w2sX(c0.x), w2sY(c0.y));
    ctx.lineTo(w2sX(bx + nx * (size * 0.42 / state.view.scale)), w2sY(by + ny * (size * 0.42 / state.view.scale)));
    ctx.lineTo(w2sX(bx - nx * (size * 0.42 / state.view.scale)), w2sY(by - ny * (size * 0.42 / state.view.scale)));
    ctx.closePath();
    ctx.fill();
  }

  function drawBoundsRect(b, color, fill, dash) {
    if (!b || !b.valid() || !state.showBounds) return;
    const x = w2sX(b.xmin), y = w2sY(b.ymax), ww = b.width() * state.view.scale, hh = b.height() * state.view.scale;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash || [4, 3]);
    if (fill) { ctx.fillStyle = COL.boundsFill; ctx.fillRect(x, y, ww, hh); }
    ctx.strokeRect(x, y, ww, hh);
    ctx.restore();
  }

  /* 弧在 X/Y 轴上的候选极值（含弧内判定） */
  function arcExtremePoints(p) {
    const arc = p.arc, m = p.matrix, out = [];
    const axes = [
      { A: m[0] * arc.r, B: m[1] * arc.r, K: m[4] + m[0] * arc.cx + m[1] * arc.cy, axis: 'x' },
      { A: m[2] * arc.r, B: m[3] * arc.r, K: m[5] + m[2] * arc.cx + m[3] * arc.cy, axis: 'y' }
    ];
    axes.forEach((ax) => {
      [Math.atan2(ax.B, ax.A), Math.atan2(ax.B, ax.A) + Math.PI].forEach((t) => {
        if (C.angleInArc(t, arc.a0, arc.sweep)) {
          const q = C.matrix.apply(m, C.arcPointLocal(arc, t));
          const val = ax.axis === 'x' ? q.x : q.y;
          const bnd = ax.axis === 'x'
            ? (Math.abs(val - p.bounds.xmin) < 1e-7 ? 'min' : Math.abs(val - p.bounds.xmax) < 1e-7 ? 'max' : null)
            : (Math.abs(val - p.bounds.ymin) < 1e-7 ? 'min' : Math.abs(val - p.bounds.ymax) < 1e-7 ? 'max' : null);
          if (bnd) {
            const endpoint =
              (Math.abs(q.x - p.a.x) < 1e-7 && Math.abs(q.y - p.a.y) < 1e-7) ||
              (Math.abs(q.x - p.b.x) < 1e-7 && Math.abs(q.y - p.b.y) < 1e-7);
            out.push({ p: q, axis: ax.axis, which: bnd, interior: !endpoint });
          }
        }
      });
    });
    return out;
  }

  function drawSegmentDimensions(p) {
    if (!state.showDim) return;
    drawBoundsRect(p.bounds, COL.bounds, true);
    // 端点
    [p.a, p.b].forEach((q, i) => {
      marker(q, COL.endpoint, 3.5);
      label(q, (i === 0 ? 'A ' : 'B ') + fmtP(q), COL.endpoint, i === 0 ? 9 : -9, -8);
    });
    if (p.type === 'arc') {
      // 弧中点
      marker(p.mid, COL.midpoint, 3);
      label(p.mid, '弧中点 ' + fmtP(p.mid), COL.midpoint, 9, 10);
      // 弧内极值
      arcExtremePoints(p).filter((e) => e.interior).forEach((e) => {
        cross(e.p, COL.extreme, 4.5);
        label(e.p, (e.axis === 'x' ? 'X' : 'Y') + e.which + ' 极值 ' + fmtP(e.p),
          COL.extreme, 9, e.which === 'max' ? -8 : 14);
      });
    }
  }

  function marker(q, color, r) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(w2sX(q.x), w2sY(q.y), r, 0, Math.PI * 2);
    ctx.fill();
  }
  function cross(q, color, r) {
    const x = w2sX(q.x), y = w2sY(q.y);
    ctx.strokeStyle = color; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
    ctx.stroke();
  }
  function label(q, text, color, dx, dy) {
    const x = w2sX(q.x) + dx, y = w2sY(q.y) + dy;
    ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(15,20,26,.82)';
    ctx.fillRect(x - 3, y - 10, tw + 6, 13);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /* ---------------- 拾取 ---------------- */
  function findPrim(occ, key) {
    for (const p of occ.primitives) {
      if (p.entityLine === key.entityLine && p.seg === key.seg) return p;
    }
    for (const c of occ.children) {
      const hit = findPrim(c, key);
      if (hit) return hit;
    }
    return null;
  }

  function pointSegDist(px, py, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    let t = l2 ? ((px - a.x) * vx + (py - a.y) * vy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + vx * t, qy = a.y + vy * t;
    return Math.hypot(px - qx, py - qy);
  }

  function hitTest(wx, wy) {
    const tol = 7 / state.view.scale;
    let best = null;
    state.model.primitives.forEach((p) => {
      let d;
      if (p.type === 'line') {
        d = pointSegDist(wx, wy, p.a, p.b);
      } else {
        const pts = C.tessellateArc(p.arc, p.matrix);
        d = Infinity;
        for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, pointSegDist(wx, wy, pts[i], pts[i + 1]));
      }
      if (d <= tol) {
        const depth = p.owner.depth;
        if (!best || depth > best.depth || (depth === best.depth && d < best.d)) {
          best = { p: p, depth: depth, d: d };
        }
      }
    });
    return best;
  }

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    state.drag = { x: e.clientX, y: e.clientY, offX: state.view.offX, offY: state.view.offY, moved: false, btn: e.button };
  });
  canvas.addEventListener('mousemove', (e) => {
    if (!state.drag) return;
    const dx = e.clientX - state.drag.x, dy = e.clientY - state.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.drag.moved = true;
    if (state.drag.moved && (state.drag.btn === 1 || state.drag.btn === 2 || state.drag.btn === 0)) {
      state.view.offX = state.drag.offX + dx;
      state.view.offY = state.drag.offY - dy;
      draw();
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (!state.drag) return;
    const wasDrag = state.drag;
    state.drag = null;
    if (!wasDrag.moved && wasDrag.btn === 0) {
      const r = canvas.getBoundingClientRect();
      const wx = s2wX(e.clientX - r.left), wy = s2wY(e.clientY - r.top);
      const hit = hitTest(wx, wy);
      if (hit) {
        selectOccurrence(hit.p.owner.id, { entityLine: hit.p.entityLine, seg: hit.p.seg });
      } else {
        // 点空白：保留实例但取消段；再点空白取消实例
        if (state.selectedSeg) { state.selectedSeg = null; renderDetails(); draw(); }
        else if (state.selectedId) {
          state.selectedId = null; state.selectedSeg = null;
          renderTree(); renderDetails(); updateReviewUi(); draw();
        }
      }
    }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function selectOccurrence(id, segKey) {
    state.selectedId = id;
    state.selectedSeg = segKey || null;
    renderTree();
    renderDetails();
    updateReviewUi();
    draw();
    // 确保树中可见
    const row = treeEl.querySelector('[data-id="' + cssEscape(id) + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  function cssEscape(s) { return String(s).replace(/"/g, '\\"'); }

  /* ---------------- 实例树 ---------------- */
  function renderTree() {
    if (!state.model) { treeEl.innerHTML = '<div class="hint">导入 DXF 后在此选择具体插入实例。</div>'; return; }
    statsEl.textContent = state.model.leafCount + ' 实体 / ' + countOccs(state.model.occurrences) + ' 实例';
    treeEl.innerHTML = '';
    state.model.occurrences.forEach((o) => treeEl.appendChild(treeNode(o, true)));
  }
  function countOccs(list) {
    let n = 0;
    list.forEach((o) => { n += 1 + countOccs(o.children); });
    return n;
  }
  function treeNode(o, expandedDefault) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row' + (o.kind === 'insert' ? '' : ' root') +
      (state.selectedId === o.id ? ' sel' : '');
    row.dataset.id = o.id;
    const hasKids = o.children.length > 0;
    const reviewN = state.reviews.filter((r) => r.id === o.id).length;
    const mirrored = o.kind === 'insert' && o.params.sx * o.params.sy < 0;
    row.innerHTML =
      '<span class="twisty">' + (hasKids ? (expandedDefault ? '▾' : '▸') : '') + '</span>' +
      '<span class="ico">' + (o.kind === 'insert' ? '⬚' : '✎') + '</span>' +
      '<span class="nm">' + esc(o.kind === 'insert' ? o.name : o.source.kind + '（根实体）') + '</span>' +
      (mirrored ? '<span class="flag" title="含负比例（镜像）">⇋镜像</span>' : '') +
      (reviewN ? '<span class="flag">⚠' + reviewN + '</span>' : '') +
      '<span class="tag">L' + (o.source ? o.source.line : '?') + '</span>';
    row.addEventListener('click', () => selectOccurrence(o.id, null));
    wrap.appendChild(row);
    if (hasKids) {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      if (!expandedDefault) kids.style.display = 'none';
      o.children.forEach((c) => kids.appendChild(treeNode(c, false)));
      row.querySelector('.twisty').addEventListener('click', (e) => {
        e.stopPropagation();
        const open = kids.style.display !== 'none';
        kids.style.display = open ? 'none' : '';
        row.querySelector('.twisty').textContent = open ? '▸' : '▾';
      });
      wrap.appendChild(kids);
    }
    return wrap;
  }

  /* ---------------- 右侧量测 ---------------- */
  function renderDetails() {
    if (!state.model) { detailsEl.innerHTML = '<div class="hint">在左侧树或图纸中点选一个实例。</div>'; return; }
    if (!state.selectedId) { detailsEl.innerHTML = '<div class="hint">在左侧树或图纸中点选一个实例。</div>'; return; }
    const occ = state.model.findOccurrence(state.selectedId);
    if (!occ) { detailsEl.innerHTML = '<div class="hint">实例不存在。</div>'; return; }

    let html = '';
    // 路径
    html += '<div class="dpath"><div>' + pathHtml(occ) + '</div>' +
      '<div class="did">实例标识：' + esc(occ.id) + ' · 深度 ' + occ.depth + ' 层' +
      ' · DXF 行号 ' + (occ.source ? occ.source.line : '-') + '</div></div>';

    // 插入参数（可编辑）
    if (occ.kind === 'insert') {
      const p = occ.params, base = occ.basePoint || { x: 0, y: 0 };
      const mirror = p.sx * p.sy < 0;
      const nonUni = Math.abs(p.sx) !== Math.abs(p.sy);
      html += '<div class="section-t">插入参数（可修改 · 仅影响本实例）</div>';
      html += '<div class="edit-box">' +
        '<div class="row"><label>插入点 X<input type="number" step="any" id="ed-x" value="' + p.x + '"></label>' +
        '<label>插入点 Y<input type="number" step="any" id="ed-y" value="' + p.y + '"></label></div>' +
        '<div class="row"><label>X 比例<input type="number" step="any" id="ed-sx" value="' + p.sx + '"></label>' +
        '<label>Y 比例<input type="number" step="any" id="ed-sy" value="' + p.sy + '"></label></div>' +
        '<div class="row"><label>旋转角 (°)<input type="number" step="any" id="ed-rot" value="' + p.rotation + '"></label>' +
        '<label>块基点（只读）<input value="(' + C.fmt(base.x) + ', ' + C.fmt(base.y) + ')" disabled></label></div>' +
        '<div class="btns"><button class="btn primary sm" id="applyEdit">应用并重展开</button>' +
        '<button class="btn sm" id="revertEdit">还原此项</button></div>' +
        (mirror ? '<div class="warn">⇋ 负比例：当前为镜像插入（X/Y 比例异号），弧的扫掠方向在图纸坐标中反转。</div>' : '') +
        (nonUni && !mirror ? '<div class="warn">X/Y 比例不等：圆弧变换为椭圆弧，按参数曲线量测（不退化为直线段）。</div>' : '') +
        (nonUni && mirror ? '<div class="warn">非均匀 + 镜像：变换后为镜像椭圆弧，包围盒按极值解析求解。</div>' : '') +
        '</div>';
    }

    // 实例包围盒
    const b = occ.subTreeBounds;
    html += '<div class="section-t">实例包围盒（图纸坐标，含弧内极值）</div>';
    html += '<table class="meas"><tbody>' +
      rowKV('xmin / xmax', C.fmt(b.xmin) + ' &nbsp;→&nbsp; ' + C.fmt(b.xmax)) +
      rowKV('ymin / ymax', C.fmt(b.ymin) + ' &nbsp;→&nbsp; ' + C.fmt(b.ymax)) +
      rowKV('宽 × 高', C.fmt(b.width()) + ' × ' + C.fmt(b.height())) +
      '</tbody></table>';

    // 段清单（该叶子实例直接几何 + 递归列出子树所有段）
    const all = [];
    (function collect(o) {
      o.primitives.forEach((pp) => all.push({ occ: o, p: pp }));
      o.children.forEach(collect);
    })(occ);

    html += '<div class="section-t">图元段（' + all.length + '）· 点击查看量测</div>';
    all.forEach((item) => {
      const p = item.p;
      const key = p.entityLine + ':' + (p.seg === undefined ? '-' : p.seg);
      const sel = state.selectedSeg && state.selectedSeg.entityLine === p.entityLine && state.selectedSeg.seg === p.seg;
      html += '<div class="seg-card' + (sel ? ' arcsel' : '') + '" data-line="' + p.entityLine + '" data-seg="' + (p.seg === undefined ? '' : p.seg) + '">';
      const ownerTxt = item.occ === occ ? '' : ' <span class="tag">位于子实例 ' + esc(item.occ.name) + '</span>';
      if (p.type === 'line') {
        html += '<div class="seg-head"><span class="pill line">直线</span>' +
          (p.closing ? '<span class="pill close">闭合段</span>' : '') +
          '<b>' + p.entityKind + '</b> L' + p.entityLine +
          (p.seg !== undefined ? ' 段' + p.seg : '') + ownerTxt + '</div>';
        html += '<table class="meas"><tbody>' +
          rowKV('端点 A', fmtP(p.a)) + rowKV('端点 B', fmtP(p.b)) +
          rowKV('长度', C.fmt(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y))) +
          rowKV('包围盒', boundsTxt(p.bounds)) +
          '</tbody></table>';
      } else {
        const sweepDeg = p.arc.sweep * 180 / Math.PI;
        html += '<div class="seg-head"><span class="pill arc">圆弧</span>' +
          (p.closing ? '<span class="pill close">闭合弧</span>' : '') +
          '<b>' + p.entityKind + '</b> L' + p.entityLine + ' 段' + p.seg + ownerTxt + '</div>';
        const det = C.matrix.det(p.matrix);
        html += '<table class="meas"><tbody>' +
          rowKV('端点 A', fmtP(p.a)) +
          rowKV('端点 B', fmtP(p.b)) +
          rowKV('弧中点', fmtP(p.mid)) +
          rowKV('bulge', C.fmt(p.bulge) + ' = tan(θ/4)') +
          rowKV('局部方向', sweepDeg > 0 ? '<span class="dir-ccw">逆时针 CCW</span>' : '<span class="dir-cw">顺时针 CW</span>') +
          rowKV('图纸方向', p.worldCCW ? '<span class="dir-ccw">逆时针 CCW</span>' : '<span class="dir-cw">顺时针 CW</span>' +
            (det < 0 ? '（镜像反转）' : '')) +
          rowKV('局部圆心', '(' + C.fmt(p.arc.cx) + ', ' + C.fmt(p.arc.cy) + ')') +
          rowKV('原半径', C.fmt(p.arc.r)) +
          rowKV('有向圆心角', C.fmt(sweepDeg) + '°') +
          rowKV('包围盒', boundsTxt(p.bounds)) +
          '</tbody></table>';
        const ex = arcExtremePoints(p).filter((e) => e.interior);
        if (ex.length) {
          html += '<div style="font-size:11px;color:var(--extreme);margin-top:3px">弧内极值点：' +
            ex.map((e) => (e.axis === 'x' ? 'X' : 'Y') + e.which + ' (' + fmtP(e.p) + ')').join('；') + '</div>';
        }
        html += '<div class="muted" style="font-size:10.5px;margin-top:3px">非均匀缩放/镜像后为椭圆弧，以上为参数曲线解析结果。</div>';
      }
      html += '</div>';
    });

    detailsEl.innerHTML = html;

    // 事件绑定
    if (occ.kind === 'insert') {
      $('#applyEdit').addEventListener('click', () => applyEdit(occ));
      $('#revertEdit').addEventListener('click', () => {
        delete state.overrides[occ.id];
        if (Object.keys(state.overrides).length === 0) $('#resetOverridesBtn').disabled = true;
        rebuild();
      });
    }
    detailsEl.querySelectorAll('.seg-card').forEach((card) => {
      card.addEventListener('click', () => {
        const seg = card.dataset.seg === '' ? undefined : parseInt(card.dataset.seg, 10);
        state.selectedSeg = { entityLine: parseInt(card.dataset.line, 10), seg: seg };
        renderDetails();
        draw();
      });
    });
  }

  function applyEdit(occ) {
    const v = (id) => Number($(id).value);
    const sx = v('#ed-sx'), sy = v('#ed-sy');
    if (!isFinite(v('#ed-x')) || !isFinite(v('#ed-y')) || !isFinite(sx) || !isFinite(sy) || !isFinite(v('#ed-rot'))) {
      toast('参数必须是有限数值', 'err'); return;
    }
    if (Math.abs(sx) < 1e-9 || Math.abs(sy) < 1e-9) {
      toast('零缩放明确拒绝：请输入非零 X/Y 比例', 'err'); return;
    }
    state.overrides[occ.id] = { x: v('#ed-x'), y: v('#ed-y'), sx: sx, sy: sy, rotation: v('#ed-rot') };
    $('#resetOverridesBtn').disabled = false;
    try {
      rebuild();
      toast('已仅对实例 ' + occ.id + '（块 ' + occ.name + '）应用修改，其他实例不受影响', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function rowKV(k, v) { return '<tr><td class="k">' + k + '</td><td class="v">' + v + '</td></tr>'; }
  function fmtP(q) { return '(' + C.fmt(q.x) + ', ' + C.fmt(q.y) + ')'; }
  function boundsTxt(b) {
    return 'X[' + C.fmt(b.xmin) + ', ' + C.fmt(b.xmax) + ']<br/>Y[' + C.fmt(b.ymin) + ', ' + C.fmt(b.ymax) + ']';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function pathHtml(occ) {
    // 由 core 生成的可读路径：每个步骤都带该层自己的插入参数
    const parts = ['<span class="step">图纸根</span>'];
    occ.path.forEach((st) => {
      let txt = esc(st.block);
      if (st.params) {
        const p = st.params;
        txt += ' <span class="depth">@(' + C.fmt(p.x) + ',' + C.fmt(p.y) + ') s=(' +
          C.fmt(p.sx) + ',' + C.fmt(p.sy) + ') r=' + C.fmt(p.rotation) + '°</span>';
      }
      parts.push('<span class="arrow">→</span><span class="step">' + txt + '</span>');
    });
    return parts.join(' ');
  }

  /* ---------------- 审图记录 ---------------- */
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    $('#tab-inspect').hidden = t.dataset.tab !== 'inspect';
    $('#tab-review').hidden = t.dataset.tab !== 'review';
  }));

  function currentReviewTargetText() {
    if (!state.selectedId) return null;
    const occ = state.model.findOccurrence(state.selectedId);
    if (!occ) return null;
    return occ.path.map((s) => s.block).join(' → ');
  }

  function updateReviewUi() {
    const occ = state.selectedId && state.model ? state.model.findOccurrence(state.selectedId) : null;
    $('#reviewTarget').textContent = occ
      ? '记录指向：' + currentReviewTargetText() + '  [' + occ.id + ']'
      : '未选择实例';
    $('#addReviewBtn').disabled = !occ;
    $('#reviewNote').value = '';
    const list = $('#reviewList');
    if (state.reviews.length === 0) {
      list.innerHTML = '<div class="empty-rev">尚无审图记录。<br/>选中实例后可把问题精确指回该插入实例。</div>';
    } else {
      list.innerHTML = '';
      state.reviews.slice().sort((a, b) => b.time - a.time).forEach((r) => {
        const div = document.createElement('div');
        div.className = 'review-item';
        const valid = state.model && state.model.findOccurrence(r.id);
        div.innerHTML = '<span class="del" title="删除">✕</span>' +
          '<div class="meta">' + new Date(r.time).toLocaleString() + (valid ? '' : '（实例已不存在）') + '</div>' +
          '<div class="path">[' + esc(r.id) + '] ' + esc(r.path) + '</div>' +
          '<div class="txt">' + esc(r.note) + '</div>';
        div.addEventListener('click', (e) => {
          if (e.target.classList.contains('del')) {
            state.reviews = state.reviews.filter((x) => x !== r);
            updateReviewUi(); renderTree();
            return;
          }
          if (valid) {
            selectOccurrence(r.id, r.seg || null);
            tabs.forEach((x) => x.classList.toggle('active', x.dataset.tab === 'inspect'));
            $('#tab-inspect').hidden = false; $('#tab-review').hidden = true;
          }
        });
        list.appendChild(div);
      });
    }
    const n = state.reviews.length;
    const badge = $('#reviewBadge');
    badge.hidden = n === 0; badge.textContent = n;
    $('#exportReviewBtn').disabled = n === 0;
    $('#clearReviewBtn').disabled = n === 0;
  }

  $('#addReviewBtn').addEventListener('click', () => {
    const note = $('#reviewNote').value.trim();
    if (!note) { toast('请填写问题描述', 'err'); return; }
    const occ = state.model.findOccurrence(state.selectedId);
    state.reviews.push({
      time: Date.now(),
      file: state.fileName,
      id: occ.id,
      path: currentReviewTargetText(),
      seg: state.selectedSeg ? { entityLine: state.selectedSeg.entityLine, seg: state.selectedSeg.seg } : null,
      note: note
    });
    updateReviewUi();
    renderTree();
    toast('已记录并指回实例 ' + occ.id, 'ok');
  });

  $('#clearReviewBtn').addEventListener('click', () => {
    if (!confirm('清空全部审图记录？')) return;
    state.reviews = [];
    updateReviewUi(); renderTree();
  });

  $('#exportReviewBtn').addEventListener('click', () => {
    const payload = {
      file: state.fileName,
      exportedAt: new Date().toISOString(),
      count: state.reviews.length,
      reviews: state.reviews
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.fileName.replace(/\.[^.]+$/, '') || 'dxf') + '-审图报告.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------------- 初始 ---------------- */
  resizeCanvas();
  if (!state.model) drawGrid(canvas.clientWidth, canvas.clientHeight);
  updateZoomLabel();
})();
