import { parseDxf } from '../dxf/parser.js';
import { expandDrawing, ExpansionError } from '../dxf/expand.js';
import { geometryPaths, screenPointFromWorld } from './render.js';
import { allSegments } from '../dxf/expand.js';
import { transformedPointAt } from '../geometry/arc.js';
import { determinant } from '../geometry/transform.js';

const els = {
  fileInput: document.querySelector('#file-input'),
  fileName: document.querySelector('#file-name'),
  expansionCount: document.querySelector('#expansion-count'),
  tree: document.querySelector('#tree'),
  canvas: document.querySelector('#canvas'),
  geometryLayer: document.querySelector('#geometry-layer'),
  overlayLayer: document.querySelector('#overlay-layer'),
  details: document.querySelector('#details'),
  dropNote: document.querySelector('#drop-note'),
  toast: document.querySelector('#toast'),
  zoomLabel: document.querySelector('#zoom-label'),
  zoomIn: document.querySelector('#zoom-in'),
  zoomOut: document.querySelector('#zoom-out'),
  fit: document.querySelector('#fit-view'),
  reset: document.querySelector('#reset-view'),
  findingText: document.querySelector('#finding-text'),
  addFinding: document.querySelector('#add-finding'),
  findingList: document.querySelector('#finding-list'),
};

const state = {
  fileName: '',
  drawing: null,
  expansion: null,
  overrides: new Map(),
  selection: null,
  findings: [],
  view: { scale: 1, panX: 0, panY: 0 },
  drag: null,
};

function showError(error) {
  els.toast.hidden = false;
  els.toast.classList.remove('ok');
  els.toast.textContent = error.message || String(error);
}

function showOkay(message) {
  els.toast.hidden = false;
  els.toast.classList.add('ok');
  els.toast.textContent = message;
  window.setTimeout(() => {
    if (els.toast.classList.contains('ok')) els.toast.hidden = true;
  }, 2400);
}

function clearToast() {
  els.toast.hidden = true;
}

function fmt(value) {
  if (!Number.isFinite(value)) return '—';
  return Number(value.toFixed(6)).toString();
}

function pointText(p) {
  return `(${fmt(p.x)}, ${fmt(p.y)})`;
}

function pathOf(nodeOrSegment) {
  if (nodeOrSegment.path) return nodeOrSegment.path;
  if (nodeOrSegment.leaf) return nodeOrSegment.leaf.path;
  return [];
}

function pathLabel(path, suffix) {
  const parts = path.map((entry, i) =>
    `${i + 1}. ${entry.name} local=${fmt(entry.localPoint.x)},${fmt(entry.localPoint.y)} world=${fmt(entry.worldPoint.x)},${fmt(entry.worldPoint.y)} s=${fmt(entry.sx)},${fmt(entry.sy)} r=${fmt(entry.rotationDeg)}°`);
  if (suffix) parts.push(suffix);
  return parts.length ? parts.join('  →  ') : suffix || '图纸空间实体';
}

function selectionLabel(selection) {
  if (!selection) return '';
  if (selection.type === 'insert') {
    const node = findInsert(selection.id);
    return pathLabel(node?.path || [], 'INSERT');
  }
  if (selection.type === 'leaf') {
    const leaf = findLeaf(selection.id);
    return pathLabel(leaf?.path || [], leaf?.entityKind.toUpperCase());
  }
  const segment = findSegment(selection.leafId, selection.segmentId);
  return pathLabel(segment || [], segment?.arc ? `弧段 #${segment.index + 1}` : `线段 #${segment.index + 1}`);
}

function findInsert(id, nodes = state.expansion?.nodes || []) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === 'insert') {
      const found = findInsert(id, node.children);
      if (found) return found;
    }
  }
  return null;
}

function findLeaf(id, nodes = state.expansion?.nodes || []) {
  for (const node of nodes) {
    if (node.id === id && node.kind === 'leaf') return node;
    if (node.kind === 'insert') {
      const found = findLeaf(id, node.children);
      if (found) return found;
    }
  }
  return null;
}

function findSegment(leafId, segmentId) {
  const leaf = findLeaf(leafId);
  return leaf?.segments?.find((segment) => segment.id === segmentId);
}

function setSelection(selection) {
  state.selection = selection;
  renderTree();
  renderDetails();
  renderOverlay();
}

function rebuildExpansion() {
  const expansion = expandDrawing(state.drawing, state.overrides);
  state.expansion = expansion;
  if (state.pendingSelection?.type === 'insert') {
    const target = expansion.insertNodes.find((node) => node.overrideKey === state.pendingSelection.key);
    state.selection = target ? { type: 'insert', id: target.id } : null;
    state.pendingSelection = null;
  }
  fitView();
  renderAll();
}

async function loadFile(file) {
  clearToast();
  try {
    const text = await file.text();
    const drawing = parseDxf(text);
    state.fileName = file.name;
    state.drawing = drawing;
    state.overrides = new Map();
    state.selection = null;
    state.findings = [];
    state.pendingSelection = null;
    rebuildExpansion();
    els.fileName.textContent = `${file.name} · ${expansionStats(state.expansion)}`;
    els.dropNote.style.display = 'none';
    showOkay('DXF 已解析并展开真实插入实例');
  } catch (error) {
    showError(error);
  }
}

function expansionStats(expansion) {
  if (!expansion) return '';
  return `${expansion.leafCount}/60 实体，${expansion.insertNodes.length} 个插入节点`;
}

function svgEl(tag, attrs = {}, children = []) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') element.textContent = value;
    else element.setAttribute(key, value);
  }
  for (const child of children) element.append(child);
  return element;
}

function htmlEl(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else element[key] = value;
  }
  for (const child of children) element.append(child);
  return element;
}

function renderAll() {
  els.expansionCount.textContent = expansionStats(state.expansion);
  renderTree();
  renderGeometry();
  renderDetails();
  renderFindings();
  renderOverlay();
}

function renderTree() {
  els.tree.textContent = '';
  if (!state.expansion) {
    els.tree.textContent = '导入 DXF 后显示实例树';
    els.tree.classList.add('empty');
    return;
  }
  els.tree.classList.remove('empty');

  const renderNode = (node) => {
    const wrapper = htmlEl('div', { className: 'tree-node' });
    const depth = node.kind === 'insert' ? node.path.length : (node.path?.length || 0) + 1;
    const selected =
      state.selection?.type === 'insert' && state.selection.id === node.id ||
      state.selection?.type === 'leaf' && state.selection.id === node.id;
    const label = node.kind === 'insert'
      ? `▦ ${node.name}`
      : node.entityKind === 'line' ? '— LINE' : `◔ LWPOLYLINE (${node.vertices.length} 点)`;
    const row = htmlEl('button', {
      className: `tree-row depth-${Math.max(1, Math.min(4, depth))}${selected ? ' selected' : ''}`,
      onclick: () => setSelection(node.kind === 'insert' ? { type: 'insert', id: node.id } : { type: 'leaf', id: node.id }),
    }, [
      htmlEl('span', { className: 'path-name', text: label }),
      htmlEl('span', { className: 'kind', text: node.kind === 'insert' ? `L${node.path.length}` : '实体' }),
    ]);
    wrapper.append(row);

    if (node.kind === 'insert') {
      for (const child of node.children) wrapper.append(renderNode(child));
    } else if (node.entityKind === 'polyline') {
      node.segments.forEach((segment, i) => {
        const segmentSelected = state.selection?.type === 'segment' && state.selection.segmentId === segment.id;
        wrapper.append(htmlEl('button', {
          className: `tree-row depth-${Math.min(4, depth + 1)}${segmentSelected ? ' selected' : ''}`,
          onclick: () => setSelection({ type: 'segment', leafId: node.id, segmentId: segment.id }),
        }, [
          htmlEl('span', { text: `${segment.arc ? '◠' : '—'} ${segment.closing ? '闭合段 ' : ''}#${i + 1}` }),
          htmlEl('span', { className: 'kind', text: segment.arc ? '圆弧' : '直线' }),
        ]));
      });
    }
    return wrapper;
  };

  state.expansion.nodes.forEach((node) => els.tree.append(renderNode(node)));
}

function renderGeometry() {
  els.geometryLayer.textContent = '';
  if (!state.expansion) return;

  for (const pathInfo of geometryPaths(state.expansion, state.view)) {
    const selectedLeaf = state.selection?.type === 'leaf' && state.selection.id === pathInfo.id;
    const selectedSegment = state.selection?.type === 'segment' && state.selection.leafId === pathInfo.id;
    const visible = svgEl('path', {
      d: pathInfo.d,
      class: `geo-path${selectedLeaf || selectedSegment ? ' selected' : ''}`,
      'data-leaf-id': pathInfo.id,
    });
    const hit = svgEl('path', {
      d: pathInfo.d,
      fill: 'none',
      stroke: 'transparent',
      'stroke-width': 10,
      'vector-effect': 'non-scaling-stroke',
      'data-leaf-id': pathInfo.id,
      style: 'cursor:pointer',
    });
    const pick = (clickEvent) => {
      const item = pickSegment(clientToSvg(clickEvent));
      if (item) setSelection({ type: 'segment', leafId: item.leaf.id, segmentId: item.id });
    };
    visible.addEventListener('click', pick);
    hit.addEventListener('click', pick);
    els.geometryLayer.append(visible, hit);
  }
}

function boundsRect(bbox, color, id = '') {
  const a = screenPointFromWorld(state.view, { x: bbox.minX, y: bbox.minY });
  const b = screenPointFromWorld(state.view, { x: bbox.maxX, y: bbox.maxY });
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(b.x - a.x);
  const height = Math.abs(b.y - a.y);
  return svgEl('rect', {
    x, y, width, height, rx: 3,
    fill: 'none',
    stroke: color,
    'stroke-width': 1,
    'stroke-dasharray': '5 4',
    'data-id': id,
  });
}

function arrowElement(from, to, color) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const size = 10;
  const tip = `${to.x},${to.y}`;
  const left = `${to.x - ux * size - uy * size * 0.55},${to.y - uy * size + ux * size * 0.55}`;
  const right = `${to.x - ux * size + uy * size * 0.55},${to.y - uy * size - ux * size * 0.55}`;
  return svgEl('g', {}, [
    svgEl('line', { x1: from.x, y1: from.y, x2: to.x - ux * 3, y2: to.y - uy * 3, stroke: color, 'stroke-width': 1.6 }),
    svgEl('polygon', { points: `${tip} ${left} ${right}`, fill: color }),
  ]);
}

function renderOverlay() {
  els.overlayLayer.textContent = '';
  if (!state.expansion || !state.selection) return;
  const color = '#ffd54f';

  if (state.selection.type === 'insert') {
    const node = findInsert(state.selection.id);
    if (node?.bbox) els.overlayLayer.append(boundsRect(node.bbox, color, node.id));
    const p = screenPointFromWorld(state.view, node.insertionPoint);
    els.overlayLayer.append(svgEl('circle', { cx: p.x, cy: p.y, r: 4, fill: color }));
    return;
  }

  if (state.selection.type === 'leaf') {
    const leaf = findLeaf(state.selection.id);
    if (leaf?.bbox) els.overlayLayer.append(boundsRect(leaf.bbox, color, leaf.id));
    return;
  }

  const segment = findSegment(state.selection.leafId, state.selection.segmentId);
  if (!segment) return;
  els.overlayLayer.append(boundsRect(segment.bbox, color, segment.id));
  const p1 = screenPointFromWorld(state.view, segment.start);
  const p2 = screenPointFromWorld(state.view, segment.end);
  els.overlayLayer.append(
    svgEl('circle', { cx: p1.x, cy: p1.y, r: 4, fill: color }),
    svgEl('circle', { cx: p2.x, cy: p2.y, r: 4, fill: color }),
  );
  if (segment.arc) {
    const mid = transformedPointAt(segment.arc, segment.matrix, 0.5);
    const theta = segment.arc.startTheta + segment.arc.direction * segment.arc.sweep * 0.5;
    const r = segment.arc.radius;
    const localVelocity = {
      x: segment.arc.direction * r * -Math.sin(theta),
      y: segment.arc.direction * r * Math.cos(theta),
    };
    const m = segment.matrix;
    const worldVelocity = {
      x: m[0] * localVelocity.x + m[2] * localVelocity.y,
      y: m[1] * localVelocity.x + m[3] * localVelocity.y,
    };
    const scale = state.view.scale;
    const velocityScreen = { x: scale * worldVelocity.x, y: -scale * worldVelocity.y };
    const vLength = Math.hypot(velocityScreen.x, velocityScreen.y) || 1;
    const target = screenPointFromWorld(state.view, mid);
    const from = { x: target.x - (velocityScreen.x / vLength) * 22, y: target.y - (velocityScreen.y / vLength) * 22 };
    els.overlayLayer.append(arrowElement(from, target, color));
  }
}

function detailRow(term, value) {
  return [htmlEl('dt', { text: term }), htmlEl('dd', { text: value })];
}

function boundsDetails(bbox) {
  const fragment = document.createDocumentFragment();
  if (!bbox) {
    fragment.append(htmlEl('p', { className: 'muted', text: '空插入，没有可量测实体。' }));
    return fragment;
  }
  const list = htmlEl('dl', { className: 'kv' });
  list.append(...detailRow('min', pointText({ x: bbox.minX, y: bbox.minY })));
  list.append(...detailRow('max', pointText({ x: bbox.maxX, y: bbox.maxY })));
  list.append(...detailRow('尺寸', `${fmt(bbox.maxX - bbox.minX)} × ${fmt(bbox.maxY - bbox.minY)}`));
  if (bbox.extrema) {
    list.append(...detailRow('X 极小点', pointText(bbox.extrema.minX)));
    list.append(...detailRow('X 极大点', pointText(bbox.extrema.maxX)));
    list.append(...detailRow('Y 极小点', pointText(bbox.extrema.minY)));
    list.append(...detailRow('Y 极大点', pointText(bbox.extrema.maxY)));
  }
  fragment.append(list);
  return fragment;
}

function section(title, content) {
  const sectionEl = htmlEl('section', { className: 'detail-section' });
  sectionEl.append(htmlEl('h3', { text: title }), content);
  return sectionEl;
}

function pathBreadcrumb(path, suffix) {
  return htmlEl('div', { className: 'path-breadcrumb', text: pathLabel(path, suffix) });
}

function scaleEditor(node) {
  const box = htmlEl('form', { className: 'scale-form' });
  const xInput = htmlEl('input', { id: 'edit-sx', type: 'number', step: 'any', value: String(node.sx) });
  const yInput = htmlEl('input', { id: 'edit-sy', type: 'number', step: 'any', value: String(node.sy) });
  const xLabel = htmlEl('label', {}, [document.createTextNode('X 比例'), xInput]);
  const yLabel = htmlEl('label', {}, [document.createTextNode('Y 比例'), yInput]);
  const apply = htmlEl('button', { type: 'submit', text: '只修改此实例' });
  const reset = htmlEl('button', { type: 'button', text: '恢复定义值' });
  const actions = htmlEl('div', { className: 'actions' }, [apply, reset]);
  box.append(xLabel, yLabel, actions);

  box.addEventListener('submit', (event) => {
    event.preventDefault();
    const sx = Number(xInput.value);
    const sy = Number(yInput.value);
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx === 0 || sy === 0) {
      showError(new Error('比例必须为非零有限数；负比例表示镜像'));
      return;
    }
    try {
      const next = new Map(state.overrides);
      next.set(node.overrideKey, { sx, sy });
      expandDrawing(state.drawing, next);
      state.overrides = next;
      state.pendingSelection = { type: 'insert', key: node.overrideKey };
      rebuildExpansion();
    } catch (error) {
      showError(error);
    }
  });

  reset.addEventListener('click', () => {
    const next = new Map(state.overrides);
    next.delete(node.overrideKey);
    state.overrides = next;
    state.pendingSelection = { type: 'insert', key: node.overrideKey };
    rebuildExpansion();
  });

  return box;
}

function renderDetails() {
  els.details.textContent = '';
  if (!state.expansion) {
    els.details.textContent = '选择实例、多段线或单段圆弧 / 线段';
    els.details.classList.add('empty');
    return;
  }
  els.details.classList.remove('empty');

  const selection = state.selection;
  if (!selection) {
    const stats = htmlEl('dl', { className: 'kv' });
    stats.append(...detailRow('展开实体', `${state.expansion.leafCount} / 60`));
    stats.append(...detailRow('插入节点', `${state.expansion.insertNodes.length}`));
    stats.append(...detailRow('图纸包围盒', state.expansion.bbox ? `${pointText({x: state.expansion.bbox.minX, y: state.expansion.bbox.minY})} … ${pointText({x: state.expansion.bbox.maxX, y: state.expansion.bbox.maxY})}` : '空'));
    els.details.append(section('图纸总览', stats));
    return;
  }

  if (selection.type === 'insert') {
    const node = findInsert(selection.id);
    if (!node) return;
    els.details.append(
      section('完整插入路径', pathBreadcrumb(node.path.slice(0, -1), `INSERT ${node.name}`)),
    );
    const kv = htmlEl('dl', { className: 'kv' });
    kv.append(...detailRow('块名', node.name));
    kv.append(...detailRow('嵌套层级', `${node.path.length} / 4`));
    kv.append(...detailRow('图纸插入点', pointText(node.insertionPoint)));
    kv.append(...detailRow('块基点', pointText(node.blockBase)));
    kv.append(...detailRow('当前比例', `${fmt(node.sx)}, ${fmt(node.sy)}`));
    kv.append(...detailRow('旋转角', `${fmt(node.rotationDeg)}°`));
    els.details.append(section('实例参数', kv));
    els.details.append(section('实例比例（独立覆盖）', scaleEditor(node)));
    els.details.append(section('实例包围盒（图纸坐标）', boundsDetails(node.bbox)));
    return;
  }

  if (selection.type === 'leaf') {
    const leaf = findLeaf(selection.id);
    if (!leaf) return;
    els.details.append(section('所属插入路径', pathBreadcrumb(leaf.path, leaf.entityKind.toUpperCase())));
    if (leaf.entityKind === 'line') {
      const kv = htmlEl('dl', { className: 'kv' });
      kv.append(...detailRow('起点', pointText(leaf.start)));
      kv.append(...detailRow('终点', pointText(leaf.end)));
      els.details.append(section('图纸坐标端点', kv));
    } else {
      const points = leaf.vertices.map((p, i) => `${i + 1}: ${pointText(p)}`).join('\n');
      const summary = leaf.segments.map((segment, i) =>
        `${i + 1}. ${segment.closing ? '闭合段 ' : ''}${segment.arc ? `圆弧 bulge=${fmt(segment.bulge)}，${orientationText(segment.orientation)}` : '直线'} ${pointText(segment.start)} → ${pointText(segment.end)}`,
      ).join('\n');
      const kv = htmlEl('dl', { className: 'kv' });
      kv.append(...detailRow('闭合', leaf.closed ? '是' : '否'));
      kv.append(...detailRow('顶点', points));
      kv.append(...detailRow('分段', summary));
      els.details.append(section('多段线参数曲线', kv));
    }
    els.details.append(section('包围盒（含弧内极值）', boundsDetails(leaf.bbox)));
    return;
  }

  const segment = findSegment(selection.leafId, selection.segmentId);
  if (!segment) return;
  els.details.append(section('所属插入路径', pathBreadcrumb(segment.leaf.path, `${segment.closing ? '闭合 ' : ''}段 #${segment.index + 1}`)));
  const kv = htmlEl('dl', { className: 'kv' });
  kv.append(...detailRow('起点', pointText(segment.start)));
  kv.append(...detailRow('终点', pointText(segment.end)));
  if (segment.arc) {
    kv.append(...detailRow('原始 bulge', fmt(segment.bulge)));
    kv.append(...detailRow('弧方向', `${orientationText(segment.orientation)}（图纸平面）`));
    kv.append(...detailRow('保留形式', '非均匀变换后的参数椭圆弧，不退化为弦'));
    kv.append(...detailRow('行列式', fmt(determinant(segment.matrix))));
  } else {
    kv.append(...detailRow('类型', '直线段'));
  }
  els.details.append(section('段量测', kv));
  els.details.append(section('包围盒（端点 + 弧内极值）', boundsDetails(segment.bbox)));
}

function orientationText(orientation) {
  if (orientation > 0) return '正向 / 逆时针';
  if (orientation < 0) return '反向 / 顺时针';
  return '无方向';
}

function renderFindings() {
  els.findingList.textContent = '';
  state.findings.forEach((finding, index) => {
    const button = htmlEl('button', { type: 'button', text: '定位' });
    button.addEventListener('click', () => setSelection(finding.selection));
    const target = htmlEl('span', { className: 'finding-target', text: finding.target });
    const text = htmlEl('span', { text: finding.text });
    const remove = htmlEl('button', { type: 'button', text: '×' });
    remove.addEventListener('click', () => {
      state.findings.splice(index, 1);
      renderFindings();
    });
    const row = htmlEl('div', { className: 'finding-row' }, [button, text, remove]);
    els.findingList.append(htmlEl('li', {}, [row, target]));
  });
}

function clientToSvg(event) {
  const rect = els.canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function distanceToSegment(point, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSquared = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / lengthSquared));
  const x = a.x + vx * t;
  const y = a.y + vy * t;
  return Math.hypot(point.x - x, point.y - y);
}

function pickSegment(point) {
  let best = null;
  let bestDistance = 9;
  for (const item of allSegments(state.expansion)) {
    const start = screenPointFromWorld(state.view, item.start);
    const end = screenPointFromWorld(state.view, item.end);
    if (item.arc) {
      // Screen hit testing samples the retained parametric curve; it does not flatten the model.
      let distance = Infinity;
      for (let i = 0; i <= 48; i++) {
        const p = screenPointFromWorld(state.view, transformedPointAt(item.arc, item.matrix, i / 48));
        distance = Math.min(distance, Math.hypot(point.x - p.x, point.y - p.y));
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        best = item;
      }
    } else {
      const distance = distanceToSegment(point, start, end);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = item;
      }
    }
  }
  return best;
}

function updateZoomLabel() {
  els.zoomLabel.textContent = `${Math.round(state.view.scale * 100)}%`;
}

function canvasSize() {
  const rect = els.canvas.getBoundingClientRect();
  return {
    width: rect.width || els.canvas.clientWidth || window.innerWidth || 1,
    height: rect.height || els.canvas.clientHeight || window.innerHeight - 120 || 1,
  };
}

function fitView() {
  const { width, height } = canvasSize();
  if (!state.expansion?.bbox) {
    state.view = { scale: 1, panX: width / 2, panY: height / 2 };
    updateZoomLabel();
    return;
  }
  const bbox = state.expansion.bbox;
  const drawingWidth = Math.max(bbox.maxX - bbox.minX, 1e-9);
  const drawingHeight = Math.max(bbox.maxY - bbox.minY, 1e-9);
  const scale = Math.min(width / drawingWidth, height / drawingHeight) * 0.88;
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  state.view = {
    scale,
    panX: width / 2 - scale * cx,
    panY: height / 2 + scale * cy,
  };
  updateZoomLabel();
}

function zoomAt(factor, screenPoint) {
  const point = screenPoint || { x: els.canvas.clientWidth / 2, y: els.canvas.clientHeight / 2 };
  state.view.scale = Math.max(1e-9, Math.min(1e9, state.view.scale * factor));
  state.view.panX = point.x - factor * (point.x - state.view.panX);
  state.view.panY = point.y - factor * (point.y - state.view.panY);
  updateZoomLabel();
  renderGeometry();
  renderOverlay();
}

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (file) loadFile(file);
});

els.canvas.addEventListener('pointerdown', (event) => {
  els.canvas.classList.add('dragging');
  state.drag = { x: event.clientX, y: event.clientY, panX: state.view.panX, panY: state.view.panY, moved: false };
  els.canvas.setPointerCapture(event.pointerId);
});

els.canvas.addEventListener('pointermove', (event) => {
  if (!state.drag) return;
  const dx = event.clientX - state.drag.x;
  const dy = event.clientY - state.drag.y;
  if (Math.hypot(dx, dy) > 3) state.drag.moved = true;
  state.view.panX = state.drag.panX + dx;
  state.view.panY = state.drag.panY + dy;
  renderGeometry();
  renderOverlay();
});

els.canvas.addEventListener('pointerup', () => {
  els.canvas.classList.remove('dragging');
  state.drag = null;
});

els.canvas.addEventListener('wheel', (event) => {
  if (!state.expansion) return;
  event.preventDefault();
  zoomAt(event.deltaY < 0 ? 1.18 : 1 / 1.18, clientToSvg(event));
}, { passive: false });

els.zoomIn.addEventListener('click', () => zoomAt(1.2));
els.zoomOut.addEventListener('click', () => zoomAt(1 / 1.2));
els.fit.addEventListener('click', () => { fitView(); renderGeometry(); renderOverlay(); });
els.reset.addEventListener('click', () => {
  const { width, height } = canvasSize();
  state.view = { scale: 1, panX: width / 2, panY: height / 2 };
  updateZoomLabel();
  renderGeometry();
  renderOverlay();
});

els.addFinding.addEventListener('click', () => {
  if (!state.selection) {
    showError(new Error('请先选择一个具体插入实例或曲线段'));
    return;
  }
  const text = els.findingText.value.trim();
  if (!text) return;
  state.findings.push({ text, selection: structuredClone(state.selection), target: selectionLabel(state.selection) });
  els.findingText.value = '';
  renderFindings();
});

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('drop-active');
});
window.addEventListener('dragleave', () => document.body.classList.remove('drop-active'));
window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('drop-active');
  const file = event.dataTransfer.files?.[0];
  if (file) loadFile(file);
});

window.addEventListener('resize', () => {
  if (state.expansion) {
    renderGeometry();
    renderOverlay();
  }
});

updateZoomLabel();
