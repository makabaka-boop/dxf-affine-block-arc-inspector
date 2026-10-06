/* node js/test.js — 无依赖测试：解析、变换、bulge 圆弧、包围盒、拒绝规则、隔离性 */
'use strict';
const C = require('./dxf-core.js');
const W = require('./dxf-writer.js');

let passed = 0, failed = 0;
function approx(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-6); }
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}
function group(name, fn) {
  try { fn(); console.log('✓ ' + name); }
  catch (e) { failed++; console.error('✗ ' + name + ' 抛异常: ' + e.message + '\n' + (e.stack || '')); }
}
function expectThrow(fn, fragment, msg) {
  try { fn(); ok(false, msg + '（应当拒绝，却成功了）'); }
  catch (e) {
    ok(e.dxf && e.message.indexOf(fragment) >= 0, msg + '（得到：' + e.message + '，期望含「' + fragment + '」）');
  }
}

/* ---------- 工具：单块单行 LWPOLYLINE ---------- */
function arcDoc(k, closed, verts) {
  const w = new W();
  w.begin();
  w.startBlocks();
  w.startBlock('B', 0, 0);
  w.lwpoly(verts, !!closed);
  w.endBlock();
  w.endBlocks();
  w.startEntities();
  w.insert('B', 0, 0, 1, 1, 0);
  w.endEntities();
  return w.render();
}
function arcArc(sx, sy, rotDeg, k) {
  const w = new W();
  w.begin();
  w.startBlocks();
  w.startBlock('B', 0, 0);
  w.lwpoly([{ x: 0, y: 0, bulge: k }, { x: 10, y: 0 }], false);
  w.endBlock();
  w.endBlocks();
  w.startEntities();
  w.insert('B', 0, 0, sx, sy, rotDeg);
  w.endEntities();
  return w.render();
}
function singleArcModel(sx, sy, rot, k, bx, by) {
  const w = new W();
  w.begin();
  w.startBlocks();
  w.startBlock('B', bx || 0, by || 0);
  w.lwpoly([{ x: 0, y: 0, bulge: k }, { x: 10, y: 0 }], false);
  w.endBlock();
  w.endBlocks();
  w.startEntities();
  w.insert('B', 0, 0, sx, sy, rot);
  w.endEntities();
  const doc = C.parseDxf(w.render());
  return C.buildModel(doc);
}

/* ========== 1. bulge 解析点 ========== */
// 几何约定：CCW 半圆从左点到右点走下半圆，因此正 bulge 的弧顶在有向弦右侧。
group('bulge 0.5：CCW 106.26°，圆心 (5, 3.75)，弧顶在弦下方', () => {
  const a = C.bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5);
  ok(approx(a.cx, 5), '圆心 x=5，实际 ' + a.cx);
  ok(approx(a.cy, 3.75), '圆心 y=3.75，实际 ' + a.cy);
  ok(approx(a.r, 6.25), '半径 6.25，实际 ' + a.r);
  ok(approx(a.sweep * 180 / Math.PI, 106.2602047), 'sweep=106.26°');
  ok(a.sweep > 0, '正 bulge => CCW');
  const end = C.arcPointLocal(a, a.a0 + a.sweep);
  ok(approx(end.x, 10) && approx(end.y, 0), '扫掠终点回到 (10,0)');
  const mid = C.arcPointLocal(a, a.a0 + a.sweep / 2);
  // 角度从 216.87° 经 270°（顶点方向）到 323.13°：弧顶 (5,-2.5)
  ok(approx(mid.x, 5) && approx(mid.y, -2.5), '弧中点 (5,-2.5)，实际 ' + mid.x + ',' + mid.y);
  ok(mid.y < 0, 'CCW 弧顶在有向弦右侧（下方）');
});

group('bulge 1：半圆，圆心 (5,0)，sweep=180°，走下半圆', () => {
  const a = C.bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 1);
  ok(approx(a.cx, 5) && approx(a.cy, 0), '圆心 (5,0)');
  ok(approx(a.r, 5), '半径 5');
  ok(approx(a.sweep, Math.PI), 'sweep=π');
  const mid = C.arcPointLocal(a, a.a0 + a.sweep / 2);
  ok(approx(mid.x, 5) && approx(mid.y, -5), 'CCW 半圆顶 (5,-5)');
});

group('bulge 2：优弧 sweep≈253.74°，圆心 (5,-3.75)', () => {
  const a = C.bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 2);
  ok(approx(a.cx, 5) && approx(a.cy, -3.75), '圆心 (5,-3.75)，实际 ' + a.cx + ',' + a.cy);
  ok(approx(a.r, 6.25), '半径 6.25');
  ok(approx(a.sweep * 180 / Math.PI, 253.739795), 'sweep=253.74°');
});

group('bulge -0.5：CW，圆心 (5, -3.75)，镜像方向', () => {
  const a = C.bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, -0.5);
  ok(approx(a.cx, 5) && approx(a.cy, -3.75), '圆心 (5,-3.75)，实际 ' + a.cx + ',' + a.cy);
  ok(approx(a.r, 6.25), '半径 6.25');
  ok(a.sweep < 0, '负 bulge => CW');
  const end = C.arcPointLocal(a, a.a0 + a.sweep);
  ok(approx(end.x, 10) && approx(end.y, 0), '终点 (10,0)');
});

/* ========== 2. 非零块基点平移 ========== */
group('非零块基点：几何整体平移 -base 再按 INSERT 放置', () => {
  const m = C.buildModel(C.parseDxf(arcArc(1, 1, 0, 0.5)));
  // 基点 0：端点不动
  ok(m.leafCount === 1, '1 个展开实体，实际 ' + m.leafCount);
  let arcP = m.primitives[0];
  ok(approx(arcP.a.x, 0) && approx(arcP.a.y, 0), '基点0 起点 (0,0)');
  ok(approx(arcP.b.x, 10) && approx(arcP.b.y, 0), '基点0 终点 (10,0)');

  // 基点 (3, 8)：INSERT 到 (0,0) 时，内容平移 -base
  const m2 = singleArcModel(1, 1, 0, 0.5, 3, 8);
  arcP = m2.primitives[0];
  ok(approx(arcP.a.x, -3) && approx(arcP.a.y, -8), '非零基点 起点 (-3,-8)，实际 ' + arcP.a.x + ',' + arcP.a.y);
  ok(approx(arcP.b.x, 7) && approx(arcP.b.y, -8), '非零基点 终点 (7,-8)');
  ok(approx(arcP.arc.cx, 5) && approx(arcP.arc.cy, 3.75), '局部圆心保持块内坐标 (5,3.75)，不随基点改写');

  // INSERT 到 (100,200)
  const w = new W();
  w.begin(); w.startBlocks();
  w.startBlock('B', 3, 8);
  w.lwpoly([{ x: 0, y: 0, bulge: 0.5 }, { x: 10, y: 0 }], false);
  w.endBlock(); w.endBlocks();
  w.startEntities(); w.insert('B', 100, 200, 1, 1, 0); w.endEntities();
  const m3 = C.buildModel(C.parseDxf(w.render()));
  arcP = m3.primitives[0];
  ok(approx(arcP.a.x, 97) && approx(arcP.a.y, 192), 'INSERT(100,200) 后起点 (97,192)');
  ok(approx(arcP.b.x, 107) && approx(arcP.b.y, 192), '终点 (107,192)');
});

/* ========== 3. 非均匀缩放后的解析端点、包围盒（含弧内极值） ========== */
group('X 拉伸 2×：端点精确，包围盒包含弧内极值（底部）', () => {
  const m = singleArcModel(2, 1, 0, 0.5);
  const p = m.primitives[0];
  ok(approx(p.a.x, 0) && approx(p.b.x, 20), '端点 0 / 20');
  // 局部弧顶：圆心 (5,3.75)，k=0.5 小弧经过 270° => (5,-2.5)，拉伸后 (10,-2.5)
  ok(approx(p.mid.x, 10) && approx(p.mid.y, -2.5), '弧中点 (10,-2.5)，实际 ' + p.mid.x + ',' + p.mid.y);
  ok(approx(p.bounds.ymin, -2.5), '包围盒 ymin=-2.5（非端点极值），实际 ' + p.bounds.ymin);
  ok(approx(p.bounds.ymax, 0), 'ymax=0 为端点所在弦');
  // 与 20 万点采样对比
  const samp = C.sampledArcWorldBounds(p.arc, p.matrix);
  ok(approx(p.bounds.xmin, samp.xmin, 1e-5) && approx(p.bounds.xmax, samp.xmax, 1e-5), 'xmin/xmax 与高精度采样一致');
  ok(approx(p.bounds.ymin, samp.ymin, 1e-5) && approx(p.bounds.ymax, samp.ymax, 1e-5), 'ymin/ymax 与高精度采样一致');
});

group('非均匀 3×0.4 + 旋转 30°：极值全部来自解析求解，与采样一致', () => {
  const m = singleArcModel(3, 0.4, 30, 2); // 优弧，多个象限
  const p = m.primitives[0];
  const samp = C.sampledArcWorldBounds(p.arc, p.matrix, 400001);
  ok(approx(p.bounds.xmin, samp.xmin, 1e-5) && approx(p.bounds.xmax, samp.xmax, 1e-5), 'x 极值一致');
  ok(approx(p.bounds.ymin, samp.ymin, 1e-5) && approx(p.bounds.ymax, samp.ymax, 1e-5), 'y 极值一致');
  // 端点正确性
  ok(approx(p.a.x, 0) && approx(p.a.y, 0), '起点随旋转仍为原点');
});

/* ========== 4. 镜像（负比例）：方向反转、参数曲线保留 ========== */
group('负比例 sx=-1：镜像后弧方向反转（worldCCW），仍是弧不是线段', () => {
  const m = singleArcModel(-1, 1, 0, 0.5);
  const p = m.primitives[0];
  ok(p.type === 'arc', '保留为 arc 图元');
  ok(p.worldCCW === false, 'det<0，世界中变为顺时针，实际 ' + p.worldCCW);
  ok(approx(p.a.x, -0) && approx(p.b.x, -10), '镜像端点 (0,0)/(-10,0)');
  // 局部弧顶 (5,-2.5) 镜像后 (-5,-2.5)
  ok(approx(p.mid.x, -5) && approx(p.mid.y, -2.5), '弧中点镜像 (-5,-2.5)');
  const samp = C.sampledArcWorldBounds(p.arc, p.matrix, 200001);
  ok(approx(p.bounds.xmin, samp.xmin, 1e-5) && approx(p.bounds.ymax, samp.ymax, 1e-5), '镜像弧包围盒与采样一致');
});

group('负比例 sy=-1 + sx=-1（180°等价），方向与双负 det 为正', () => {
  const m = singleArcModel(-1, -1, 0, 0.5);
  const p = m.primitives[0];
  ok(p.worldCCW === true, 'sx=sy=-1 det=+1，CCW 保持');
  const samp = C.sampledArcWorldBounds(p.arc, p.matrix, 200001);
  ok(approx(p.bounds.xmin, samp.xmin, 1e-5) && approx(p.bounds.ymin, samp.ymin, 1e-5), '包围盒一致');
});

/* ========== 5. 跨象限圆弧：包围盒包含所有四个极值 ========== */
group('跨象限优弧 bulge=2：包围盒含弧内极值', () => {
  // 圆心 (5,-3.75)，半径 6.25，CCW 253.7°，起角 143.13° 经 180/270/360 到 36.87°
  const m = singleArcModel(1, 1, 0, 2);
  const p = m.primitives[0];
  const samp = C.sampledArcWorldBounds(p.arc, p.matrix, 500001);
  ok(approx(p.bounds.xmin, samp.xmin, 1e-6), 'xmin（弧内极值，非端点）');
  ok(approx(p.bounds.xmax, samp.xmax, 1e-6), 'xmax');
  ok(approx(p.bounds.ymin, samp.ymin, 1e-6), 'ymin');
  ok(approx(p.bounds.ymax, samp.ymax, 1e-6), 'ymax');
  // 该优弧经过 270°（底部 (5,-10)）、180°（左点 (-1.25,-3.75)）与 0°（右点 (11.25,-3.75)）
  ok(p.bounds.xmin < 0, 'xmin 越过 0（跨象限）：' + p.bounds.xmin);
  ok(p.bounds.xmax > 11, 'xmax>11（弧内极值）：' + p.bounds.xmax);
  ok(approx(p.bounds.ymin, -10), 'ymin=-10 为弧内极值，实际 ' + p.bounds.ymin);
  // 不经过 90° => ymax 由端点决定为 0
  ok(approx(p.bounds.ymax, 0), 'ymax=0（端点弦，弧不经过顶部）');
});

/* ========== 6. 闭合多段线最后闭合段 bulge ========== */
group('闭合 LWPOLYLINE：最后一个 bulge 决定末点→首点闭合弧段', () => {
  const w = new W();
  w.begin(); w.startBlocks(); w.startBlock('B', 0, 0);
  // 三角形，最后一个顶点带 bulge 1 => 闭合边为半圆
  w.lwpoly([
    { x: 0, y: 0, bulge: 0 },
    { x: 10, y: 0, bulge: 0 },
    { x: 10, y: 10, bulge: 1 } // 闭合段 (10,10) -> (0,0)
  ], true);
  w.endBlock(); w.endBlocks();
  w.startEntities(); w.insert('B', 0, 0, 1, 1, 0); w.endEntities();
  const m = C.buildModel(C.parseDxf(w.render()));
  const segs = m.primitives;
  ok(segs.length === 3, '3 段（2 直线 + 1 闭合弧），实际 ' + segs.length);
  const closing = segs[2];
  ok(closing.type === 'arc' && closing.closing === true, '第 3 段为闭合弧');
  // 弦 (10,10)->(0,0)，k=1：圆心 (0,10) 或 (10,0)；左法向（向 SW 弦，左侧为 SE）
  // 弦方向 (-1,-1)/√2，左法向 (1/√2,-1/√2)，k=1 s=0 => 圆心 (5,5)，半径 5√2
  ok(approx(closing.arc.cx, 5) && approx(closing.arc.cy, 5), '闭合弧圆心 (5,5)');
  ok(approx(closing.arc.r, Math.sqrt(50)), '半径 5√2');
  const samp = C.sampledArcWorldBounds(closing.arc, closing.matrix, 200001);
  ok(approx(closing.bounds.xmax, samp.xmax, 1e-5) && approx(closing.bounds.ymax, samp.ymax, 1e-5), '闭合弧包围盒与采样一致');

  // 非闭合时末顶点 bulge 不产生段
  const doc2 = C.parseDxf(arcDoc(1, false, [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10, bulge: 1 }
  ]));
  const m2 = C.buildModel(doc2);
  ok(m2.primitives.length === 2, '开放多段线只有 2 段，末 bulge 不生效');
});

/* ========== 7. 两层嵌套：路径与父变换组合 ========== */
group('两层嵌套：子块内容 = T_外·R_外·S_外·T_内·R_内·S_内·几何', () => {
  const w = new W();
  w.begin(); w.startBlocks();
  // 内层块 IN：基点 (1,1)，一条 LINE (0,0)-(2,0)
  w.startBlock('IN', 1, 1);
  w.line(0, 0, 2, 0);
  w.endBlock();
  // 外层块 OUT：基点 (0,0)，在 (10,0) 以 sx=2,sy=3 引用 IN
  w.startBlock('OUT', 0, 0);
  w.insert('IN', 10, 0, 2, 3, 0);
  w.endBlock();
  w.endBlocks();
  // 根：在 (0,5) 以 sx=1, sy=1 旋转 90° 引用 OUT
  w.startEntities();
  w.insert('OUT', 0, 5, 1, 1, 90);
  w.endEntities();

  const m = C.buildModel(C.parseDxf(w.render()));
  ok(m.occurrences.length === 1, '根 1 个实例');
  const outer = m.occurrences[0];
  ok(outer.name === 'OUT' && outer.children.length === 1, 'OUT 有 1 个子实例');
  const inner = outer.children[0];
  ok(inner.name === 'IN', '子块为 IN');
  ok(inner.depth === 2, '子块深度 2');
  ok(inner.id === '0>0', '实例 id 为路径 0>0，实际 ' + inner.id);
  // 路径完整
  ok(inner.path.length === 2 && inner.path[0].block === 'OUT' && inner.path[1].block === 'IN', '保留完整插入路径');
  ok(inner.path[0].params && inner.path[0].params.rotation === 90, '路径第一层带外层自己的参数（旋转90°）');
  ok(inner.path[1].params && inner.path[1].params.sx === 2 && inner.path[1].params.sy === 3, '路径第二层带内层自己的参数（sx=2,sy=3）');

  // 手算：IN 内端点 p0=(0,0)，先减 IN 基点 => (-1,-1)，内 INSERT 2,3 => (-2,-3)，
  // 平移 (10,0) => (8,-3)；外旋转 90° => (3,8)，平移 (0,5) => (3,13)
  const l = inner.primitives[0];
  ok(approx(l.a.x, 3) && approx(l.a.y, 13), 'p0 -> (3,13)，实际 ' + l.a.x + ',' + l.a.y);
  // p1=(2,0): -base => (1,-1) => (2,-3) => (12,-3) => rot90 => (3,12) => +(0,5) => (3,17)
  ok(approx(l.b.x, 3) && approx(l.b.y, 17), 'p1 -> (3,17)，实际 ' + l.b.x + ',' + l.b.y);
  ok(m.leafCount === 1, '只计 1 个 LINE 实体');
});

/* ========== 8. 修改一个插入比例不污染其他实例 / 共享块 ========== */
group('实例隔离：同一共享块两个 INSERT，改其一不影响其二与块定义', () => {
  const w = new W();
  w.begin(); w.startBlocks();
  w.startBlock('B', 0, 0);
  w.line(0, 0, 1, 0);
  w.endBlock();
  w.endBlocks();
  w.startEntities();
  w.insert('B', 0, 0, 1, 1, 0);
  w.insert('B', 0, 0, 1, 1, 0);
  w.endEntities();
  const doc = C.parseDxf(w.render());
  const base = C.buildModel(doc);
  const id0 = base.occurrences[0].id, id1 = base.occurrences[1].id;
  const edited = C.buildModel(doc, { [id0]: { sx: 5, sy: 7 } });
  const a0 = edited.occurrences[0].primitives[0];
  const a1 = edited.occurrences[1].primitives[0];
  ok(approx(a0.b.x, 5) && approx(a0.b.y, 0), '实例0 改后终点 (5,0)');
  ok(approx(a1.b.x, 1) && approx(a1.b.y, 0), '实例1 保持 (1,0)');
  ok(edited.occurrences[1].params.sx === 1, '实例1 参数仍为 sx=1');
  // 块定义本身未变：不带覆盖再展开
  const again = C.buildModel(doc, { [id0]: { sx: 9, sy: 9 } });
  ok(approx(again.occurrences[1].primitives[0].b.x, 1), '重建模型，实例1 仍为原样（定义未污染）');
  // 原模型对象也未变
  ok(approx(base.occurrences[0].primitives[0].b.x, 1), '旧模型实例0 仍为原样（展开对象独立）');
  // 嵌套层修改
  const w2 = new W();
  w2.begin(); w2.startBlocks();
  w2.startBlock('IN', 0, 0); w2.line(0, 0, 1, 0); w2.endBlock();
  w2.startBlock('OUT', 0, 0);
  w2.insert('IN', 0, 0, 1, 1, 0);
  w2.insert('IN', 0, 0, 1, 1, 0);
  w2.endBlock();
  w2.endBlocks();
  w2.startEntities();
  w2.insert('OUT', 0, 0, 1, 1, 0);
  w2.insert('OUT', 0, 0, 1, 1, 0);
  w2.endEntities();
  const doc2 = C.parseDxf(w2.render());
  const mm = C.buildModel(doc2, { '0>0': { sx: 3, sy: 1 } }); // 仅第一个 OUT 的第一个 IN
  const out0in0 = mm.occurrences[0].children[0].primitives[0];
  const out0in1 = mm.occurrences[0].children[1].primitives[0];
  const out1in0 = mm.occurrences[1].children[0].primitives[0];
  ok(approx(out0in0.b.x, 3), '0>0 被修改');
  ok(approx(out0in1.b.x, 1), '0>1 不受影响（同块兄弟实例）');
  ok(approx(out1in0.b.x, 1), '1>0 不受影响（另一父节点下同块实例）');
});

/* ========== 9. 明确拒绝的输入 ========== */
group('拒绝规则', () => {
  // 循环引用 A->B->A
  const wc = new W();
  wc.begin(); wc.startBlocks();
  wc.startBlock('A', 0, 0); wc.insert('B', 0, 0, 1, 1, 0); wc.endBlock();
  wc.startBlock('B', 0, 0); wc.insert('A', 0, 0, 1, 1, 0); wc.endBlock();
  wc.endBlocks();
  wc.startEntities(); wc.insert('A', 0, 0, 1, 1, 0); wc.endEntities();
  expectThrow(() => C.buildModel(C.parseDxf(wc.render())), '循环块引用', '循环 A→B→A');

  // 自引用
  const ws = new W();
  ws.begin(); ws.startBlocks();
  ws.startBlock('A', 0, 0); ws.insert('A', 0, 0, 1, 1, 0); ws.endBlock();
  ws.endBlocks();
  ws.startEntities(); ws.insert('A', 0, 0, 1, 1, 0); ws.endEntities();
  expectThrow(() => C.buildModel(C.parseDxf(ws.render())), '循环块引用', '自引用');

  // 未知块
  const wu = new W();
  wu.begin(); wu.startBlocks(); wu.endBlocks();
  wu.startEntities(); wu.insert('GHOST', 0, 0, 1, 1, 0); wu.endEntities();
  expectThrow(() => C.buildModel(C.parseDxf(wu.render())), '未定义的块', '未知块 GHOST');

  // 零缩放
  expectThrow(() => C.buildModel(C.parseDxf(arcArc(0, 1, 0, 0.5))), '零缩放', 'sx=0');
  expectThrow(() => C.buildModel(C.parseDxf(arcArc(1, 0, 0, 0.5))), '零缩放', 'sy=0');

  // 深度 5 层（A1->A2->A3->A4->A5，根引用 A1，深度 5 > 4）
  const wd = new W();
  wd.begin(); wd.startBlocks();
  for (let i = 1; i <= 5; i++) {
    wd.startBlock('A' + i, 0, 0);
    if (i < 5) wd.insert('A' + (i + 1), 0, 0, 1, 1, 0);
    else wd.line(0, 0, 1, 0);
    wd.endBlock();
  }
  wd.endBlocks();
  wd.startEntities(); wd.insert('A1', 0, 0, 1, 1, 0); wd.endEntities();
  expectThrow(() => C.buildModel(C.parseDxf(wd.render())), '嵌套深度', '5 层嵌套');
  // 深度 4 层应通过
  const wd4 = new W();
  wd4.begin(); wd4.startBlocks();
  for (let i = 1; i <= 4; i++) {
    wd4.startBlock('B' + i, 0, 0);
    if (i < 4) wd4.insert('B' + (i + 1), 0, 0, 1, 1, 0);
    else wd4.line(0, 0, 1, 0);
    wd4.endBlock();
  }
  wd4.endBlocks();
  wd4.startEntities(); wd4.insert('B1', 0, 0, 1, 1, 0); wd4.endEntities();
  C.buildModel(C.parseDxf(wd4.render()));
  ok(true, '4 层嵌套通过');

  // 61 个实体
  const wm = new W();
  wm.begin(); wm.startBlocks();
  wm.startBlock('MANY', 0, 0);
  for (let i = 0; i < 61; i++) wm.line(i, 0, i + 1, 0);
  wm.endBlock(); wm.endBlocks();
  wm.startEntities(); wm.insert('MANY', 0, 0, 1, 1, 0); wm.endEntities();
  expectThrow(() => C.buildModel(C.parseDxf(wm.render())), '60', '61 个展开实体');
  // 60 个通过
  const wm60 = new W();
  wm60.begin(); wm60.startBlocks();
  wm60.startBlock('SIXTY', 0, 0);
  for (let i = 0; i < 60; i++) wm60.line(i, 0, i + 1, 0);
  wm60.endBlock(); wm60.endBlocks();
  wm60.startEntities(); wm60.insert('SIXTY', 0, 0, 1, 1, 0); wm60.endEntities();
  const m60 = C.buildModel(C.parseDxf(wm60.render()));
  ok(m60.leafCount === 60, '恰好 60 个实体通过');

  // Z 非零 LINE
  const wz = new W();
  wz.begin(); wz.startBlocks(); wz.endBlocks();
  wz.startEntities();
  wz.raw(0, 'LINE').raw(100, 'AcDbEntity').raw(8, '0').raw(100, 'AcDbLine')
    .raw(10, 0).raw(20, 0).raw(30, 1).raw(11, 1).raw(21, 1).raw(31, 0);
  wz.endEntities();
  expectThrow(() => C.parseDxf(wz.render()), 'Z 非 0', 'LINE Z=1');

  // 非默认挤出
  const we = new W();
  we.begin(); we.startBlocks(); we.endBlocks();
  we.startEntities();
  we.raw(0, 'LINE').raw(100, 'AcDbEntity').raw(8, '0').raw(100, 'AcDbLine')
    .raw(10, 0).raw(20, 0).raw(11, 1).raw(21, 0)
    .raw(210, 0).raw(220, 0).raw(230, -1);
  we.endEntities();
  expectThrow(() => C.parseDxf(we.render()), '非默认挤出方向', '挤出 (0,0,-1) 镜像 OCS');

  // 不支持的实体类型
  const wt = new W();
  wt.begin(); wt.startBlocks(); wt.endBlocks();
  wt.startEntities();
  wt.raw(0, 'CIRCLE').raw(100, 'AcDbEntity').raw(8, '0').raw(100, 'AcDbCircle')
    .raw(10, 0).raw(20, 0).raw(30, 0).raw(40, 5);
  wt.endEntities();
  expectThrow(() => C.parseDxf(wt.render()), '不支持的实体类型 CIRCLE', 'CIRCLE 拒绝');

  const wa = new W();
  wa.begin(); wa.startBlocks(); wa.endBlocks();
  wa.startEntities();
  wa.raw(0, 'TEXT').raw(100, 'AcDbEntity').raw(8, '0').raw(100, 'AcDbText')
    .raw(10, 0).raw(20, 0).raw(40, 1).raw(1, 'hello');
  wa.endEntities();
  expectThrow(() => C.parseDxf(wa.render()), 'TEXT', 'TEXT 拒绝');

  // MINSERT 阵列
  const wmi = new W();
  wmi.begin(); wmi.startBlocks();
  wmi.startBlock('B', 0, 0); wmi.line(0, 0, 1, 0); wmi.endBlock();
  wmi.endBlocks();
  wmi.startEntities();
  wmi.raw(0, 'INSERT').raw(100, 'AcDbBlockReference').raw(2, 'B')
    .raw(10, 0).raw(20, 0).raw(41, 1).raw(42, 1).raw(50, 0)
    .raw(70, 3).raw(71, 2).raw(44, 10).raw(45, 10);
  wmi.endEntities();
  expectThrow(() => C.parseDxf(wmi.render()), '阵列', '阵列 INSERT 拒绝');

  // 宽线：LWPOLYLINE 带非零 43
  const ww = new W();
  ww.begin(); ww.startBlocks(); ww.endBlocks();
  ww.startEntities();
  ww.raw(0, 'LWPOLYLINE').raw(100, 'AcDbPolyline').raw(90, 2).raw(70, 0)
    .raw(43, 2).raw(10, 0).raw(20, 0).raw(42, 0).raw(10, 1).raw(21, 0).raw(42, 0);
  ww.endEntities();
  expectThrow(() => C.parseDxf(ww.render()), '宽线', '定宽多段线拒绝');

  // 外部参照块（标志位 4）
  const wx = new W();
  wx.begin(); wx.startBlocks();
  wx.startBlockRaw ? null : null;
  wx.raw(0, 'BLOCK').raw(2, 'X').raw(70, 4).raw(10, 0).raw(20, 0).raw(3, 'X').raw(1, 'ref.dwg');
  wx.raw(0, 'ENDBLK');
  wx.endBlocks();
  wx.startEntities(); wx.endEntities();
  expectThrow(() => C.parseDxf(wx.render()), '外部参照', 'XREF 块拒绝');

  // 损坏组码
  expectThrow(() => C.parseDxf('XX\nLINE\n0\nENDSEC\n'), '组码', '非数组码拒绝');
});

/* ========== 10. 综合文档：审图发现可指回具体实例 ========== */
group('综合：实例 id 稳定，审图记录可指回', () => {
  const m = singleArcModel(2, 3, 45, 0.5, 2, 2);
  const p = m.primitives[0];
  const occ = p.owner;
  ok(occ.kind === 'insert' && occ.name === 'B', '图元挂在 INSERT 实例上');
  const found = m.findOccurrence(occ.id);
  ok(found === occ, '按 id 可指回具体插入实例');
  ok(found.path[0].block === 'B', '路径含块名 B');
  // 包围盒实例级 = 图元级（一块一弧）
  ok(approx(occ.subTreeBounds.xmin, p.bounds.xmin), '实例包围盒聚合正确');
});

console.log('\n' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
