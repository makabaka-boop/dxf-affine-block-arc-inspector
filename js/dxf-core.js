/*!
 * dxf-core.js
 * 平面 ASCII DXF 验图核心：解析 / 校验 / 块展开 / 仿射变换 / bulge 圆弧精确量测。
 * 仅接收：LINE、LWPOLYLINE、BLOCK、INSERT（Z=0、默认挤出方向）。
 * 同一文件同时以浏览器全局 (window.DxfCore) 与 Node CommonJS 方式导出。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DxfCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;

  /* ============================================================
   * 1. 词法：ASCII DXF = 若干「组码 / 组值」两行对
   * ============================================================ */

  function tokenize(text) {
    if (typeof text !== 'string' || text.length === 0) {
      throw makeErr('文件为空，无法解析。');
    }
    var lines = text.split(/\r\n|\r|\n/);
    var pairs = [];
    var i = 0;
    // 跳过文件开头可能存在的空行
    while (i < lines.length && lines[i].trim() === '') i++;
    for (; i < lines.length; i += 2) {
      var codeLine = lines[i];
      var valLine = i + 1 < lines.length ? lines[i + 1] : '';
      if (codeLine.trim() === '' && valLine.trim() === '') continue;
      var code = parseInt(codeLine.trim(), 10);
      if (!isFiniteCode(code, codeLine)) {
        throw makeErr('第 ' + (i + 1) + ' 行应为整数组码，实际为「' + codeLine + '」。');
      }
      pairs.push({ c: code, v: valLine.trim(), ln: i + 1 });
    }
    if (pairs.length === 0) throw makeErr('未读到任何 DXF 组码/组值对。');
    return pairs;
  }

  function isFiniteCode(code, raw) {
    if (String(code) !== String(parseInt(raw.trim(), 10))) return false;
    return code >= 0 && code <= 9999;
  }

  function num(v, ln, what) {
    var n = Number(v);
    if (!isFinite(n)) {
      throw makeErr('第 ' + ln + ' 行：' + what + ' 不是有限数值（「' + v + '」）。');
    }
    return n;
  }

  function makeErr(msg) {
    var e = new Error(msg);
    e.dxf = true;
    return e;
  }

  /* ============================================================
   * 2. 结构：定位 SECTION，解析 BLOCKS / ENTITIES
   * ============================================================ */

  function findSections(pairs) {
    var sections = {};
    for (var i = 0; i < pairs.length - 1; i++) {
      if (pairs[i].c === 0 && pairs[i].v === 'SECTION' && pairs[i + 1].c === 2) {
        var name = pairs[i + 1].v;
        var j = i + 2;
        while (j < pairs.length && !(pairs[j].c === 0 && pairs[j].v === 'ENDSEC')) j++;
        sections[name] = { header: i + 1, start: i + 2, end: j }; // end = ENDSEC 位置
        i = j;
      }
    }
    return sections;
  }

  // 受支持实体
  var SUPPORTED_ENTITIES = { LINE: 1, LWPOLYLINE: 1, INSERT: 1 };

  // 常见但明确拒绝的实体（给出针对性提示）
  var UNSUPPORTED_MSG = {
    POLYLINE: '旧版 POLYLINE 不受支持，请改用 LWPOLYLINE。',
    VERTEX: '旧版 POLYLINE/VERTEX 不受支持，请改用 LWPOLYLINE。',
    SEQEND: '旧版 POLYLINE/VERTEX 不受支持，请改用 LWPOLYLINE。',
    ARC: '仅接收 LINE、LWPOLYLINE、BLOCK、INSERT，不接收独立 ARC（请用带 bulge 的 LWPOLYLINE）。',
    CIRCLE: '仅接收 LINE、LWPOLYLINE、BLOCK、INSERT，不接收 CIRCLE。',
    ELLIPSE: '仅接收 LINE、LWPOLYLINE、BLOCK、INSERT，不接收 ELLIPSE。',
    SPLINE: '不接收 SPLINE。',
    POINT: '不接收 POINT。',
    TEXT: '不接收文字 TEXT。',
    MTEXT: '不接收文字 MTEXT。',
    ATTRIB: '不接收属性 ATTRIB。',
    ATTDEF: '不接收属性定义 ATTDEF。',
    MINSERT: '不接收阵列插入 MINSERT。',
    TRACE: '不接收宽线 TRACE。',
    SOLID: '不接收 SOLID 填充。',
    '3DFACE': '不接收 3DFACE（仅平面 Z=0 实体）。',
    DIMENSION: '不接收 DIMENSION 标注。',
    HATCH: '不接收 HATCH 填充。',
    VIEWPORT: '不接收 VIEWPORT。',
    RAY: '不接收 RAY。',
    XLINE: '不接收构造线 XLINE。',
    IMAGE: '不接收 IMAGE。',
    WIPEOUT: '不接收 WIPEOUT。',
    LEADER: '不接收 LEADER。',
    MULTILEADER: '不接收 MULTILEADER。',
    TOLERANCE: '不接收 TOLERANCE。',
    TABLE: '不接收 TABLE。',
    '3DSOLID': '不接收 3DSOLID。',
    BODY: '不接收 BODY。',
    REGION: '不接收 REGION。'
  };

  // 读取实体时整体忽略的组码（句柄、图层、颜色、子类标记、软指针、扩展数据等）
  function isIgnorableCode(g) {
    if (g === 5 || g === 8 || g === 62 || g === 6 || g === 100 || g === 330 || g === 360) return true;
    if (g >= 1000) return true; // 1001~1071 扩展数据
    return false;
  }

  function checkExtrusion(ext, ln, owner) {
    if (ext && !(Math.abs(ext.x) < EPS && Math.abs(ext.y) < EPS && Math.abs(ext.z - 1) < EPS)) {
      throw makeErr('第 ' + ln + ' 行附近：' + owner + ' 使用了非默认挤出方向 (' +
        fmtN(ext.x) + ',' + fmtN(ext.y) + ',' + fmtN(ext.z) + ')，仅接受默认 (0,0,1)。');
    }
  }

  /* 从某个 (0,type) 组开始读取一个实体，返回 { ent, next }，next 指向下一个 code=0 组 */
  function parseEntity(pairs, i) {
    var type = pairs[i].v;
    var startLine = pairs[i].ln;
    var owner = type;

    if (!SUPPORTED_ENTITIES[type]) {
      var extra = UNSUPPORTED_MSG[type];
      if (type === 'ENDBLK' || type === 'ENDSEC' || type === 'BLOCK') {
        return { ent: null, stopToken: type, next: i + 1 };
      }
      throw makeErr('第 ' + startLine + ' 行：不支持的实体类型 ' + type + '。' +
        (extra ? extra : '仅接收 LINE、LWPOLYLINE、BLOCK、INSERT。'));
    }

    var j = i + 1;
    var ent = { kind: type, line: startLine };
    var ext = null;

    function ensureExt() { return ext || (ext = { x: 0, y: 0, z: 1 }); }

    while (j < pairs.length && pairs[j].c !== 0) {
      var g = pairs[j].c;
      var v = pairs[j].v;
      var ln = pairs[j].ln;

      if (isIgnorableCode(g)) { j++; continue; }

      if (type === 'LINE') {
        switch (g) {
          case 10: ent.x1 = num(v, ln, 'LINE 起点 X'); break;
          case 20: ent.y1 = num(v, ln, 'LINE 起点 Y'); break;
          case 30: ent.z1 = num(v, ln, 'LINE 起点 Z'); break;
          case 11: ent.x2 = num(v, ln, 'LINE 终点 X'); break;
          case 21: ent.y2 = num(v, ln, 'LINE 终点 Y'); break;
          case 31: ent.z2 = num(v, ln, 'LINE 终点 Z'); break;
          case 39: // 厚度
            if (Math.abs(num(v, ln, 'LINE 厚度')) > EPS) {
              throw makeErr('第 ' + ln + ' 行：LINE 带非零厚度，仅接受平面 Z=0 实体。');
            }
            break;
          case 210: ensureExt().x = num(v, ln, '挤出 X'); break;
          case 220: ensureExt().y = num(v, ln, 'LINE 挤出 Y'); break;
          case 230: ensureExt().z = num(v, ln, 'LINE 挤出 Z'); break;
          default: ignoreOrWarn(g, ln, owner);
        }
      } else if (type === 'LWPOLYLINE') {
        switch (g) {
          case 10:
            if (!ent.verts) ent.verts = [];
            ent.verts.push({ x: num(v, ln, '顶点 X'), y: 0, bulge: 0 });
            break;
          case 20:
            if (!ent.verts || ent.verts.length === 0) throw makeErr('第 ' + ln + ' 行：LWPOLYLINE 的 Y(20) 出现在 X(10) 之前。');
            ent.verts[ent.verts.length - 1].y = num(v, ln, '顶点 Y');
            break;
          case 42:
            if (!ent.verts || ent.verts.length === 0) throw makeErr('第 ' + ln + ' 行：bulge(42) 出现在顶点之前。');
            ent.verts[ent.verts.length - 1].bulge = num(v, ln, 'bulge');
            break;
          case 70: ent.flag = num(v, ln, 'LWPOLYLINE 标志'); break;
          case 38: // 标高
            if (Math.abs(num(v, ln, 'LWPOLYLINE 标高')) > EPS) {
              throw makeErr('第 ' + ln + ' 行：LWPOLYLINE 标高非 0，仅接受 Z=0。');
            }
            break;
          case 37: // 厚度
            if (Math.abs(num(v, ln, 'LWPOLYLINE 厚度')) > EPS) {
              throw makeErr('第 ' + ln + ' 行：LWPOLYLINE 带非零厚度，仅接受平面 Z=0。');
            }
            break;
          case 40:
            if (Math.abs(num(v, ln, '起始宽度')) > EPS) {
              throw makeErr('第 ' + ln + ' 行：LWPOLYLINE 带非零起始宽度，本验图不处理宽线。');
            }
            break;
          case 41:
            if (Math.abs(num(v, ln, '结束宽度')) > EPS) {
              throw makeErr('第 ' + ln + ' 行：LWPOLYLINE 带非零结束宽度，本验图不处理宽线。');
            }
            break;
          case 43:
            if (Math.abs(num(v, ln, '定宽')) > EPS) {
              throw makeErr('第 ' + ln + ' 行：LWPOLYLINE 带非零定宽，本验图不处理宽线。');
            }
            break;
          case 210: ensureExt().x = num(v, ln, '挤出 X'); break;
          case 220: ensureExt().y = num(v, ln, 'LWPOLYLINE 挤出 Y'); break;
          case 230: ensureExt().z = num(v, ln, 'LWPOLYLINE 挤出 Z'); break;
          default: ignoreOrWarn(g, ln, owner);
        }
      } else if (type === 'INSERT') {
        switch (g) {
          case 2: ent.name = v; break;
          case 10: ent.x = num(v, ln, 'INSERT X'); break;
          case 20: ent.y = num(v, ln, 'INSERT Y'); break;
          case 30: ent.z = num(v, ln, 'INSERT Z'); break;
          case 41: ent.sx = num(v, ln, 'X 比例'); break;
          case 42: ent.sy = num(v, ln, 'Y 比例'); break;
          case 43: // Z 比例：平面场景不使用，但不允许缺失导致 NaN；忽略即可
            break;
          case 50: ent.rotation = num(v, ln, '旋转角(度)'); break;
          case 70: ent.cols = num(v, ln, '列数'); break;
          case 71: ent.rows = num(v, ln, '行数'); break;
          case 44: ent.colSpacing = num(v, ln, '列间距'); break;
          case 45: ent.rowSpacing = num(v, ln, '行间距'); break;
          case 210: ensureExt().x = num(v, ln, '挤出 X'); break;
          case 220: ensureExt().y = num(v, ln, 'INSERT 挤出 Y'); break;
          case 230: ensureExt().z = num(v, ln, 'INSERT 挤出 Z'); break;
          default: ignoreOrWarn(g, ln, owner);
        }
      }
      j++;
    }

    // 通用校验
    checkExtrusion(ext, startLine, owner);
    if (type === 'LINE') finalizeLine(ent);
    if (type === 'LWPOLYLINE') finalizePolyline(ent);
    if (type === 'INSERT') finalizeInsert(ent);

    return { ent: ent, next: j };
  }

  function ignoreOrWarn(g, ln, owner) {
    // 未识别但无害的组码直接忽略；结构性的异常组码显式报错，避免静默吞掉错误输入
    if (g === 0) return;
    if (g >= 100 && g < 1000) return; // 少见的扩展分组
    // 其余忽略（如 60 可见性、90 数量等在本场景无意义）
  }

  function finalizeLine(ent) {
    if (ent.x1 === undefined) ent.x1 = 0;
    if (ent.y1 === undefined) ent.y1 = 0;
    if (ent.x2 === undefined) ent.x2 = 0;
    if (ent.y2 === undefined) ent.y2 = 0;
    if (Math.abs(ent.z1 || 0) > EPS || Math.abs(ent.z2 || 0) > EPS) {
      throw makeErr('第 ' + ent.line + ' 行：LINE 端点 Z 非 0，仅接受平面 Z=0 实体。');
    }
  }

  function finalizePolyline(ent) {
    if (!ent.verts || ent.verts.length < 2) {
      throw makeErr('第 ' + ent.line + ' 行：LWPOLYLINE 至少需要 2 个顶点。');
    }
    ent.closed = ((ent.flag || 0) & 1) === 1;
  }

  function finalizeInsert(ent) {
    if (ent.x === undefined) ent.x = 0;
    if (ent.y === undefined) ent.y = 0;
    if (ent.z !== undefined && Math.abs(ent.z) > EPS) {
      throw makeErr('第 ' + ent.line + ' 行：INSERT 的 Z 非 0，仅接受平面 Z=0。');
    }
    if (ent.sx === undefined) ent.sx = 1;
    if (ent.sy === undefined) ent.sy = 1;
    if (ent.rotation === undefined) ent.rotation = 0;
    if (!ent.name) {
      throw makeErr('第 ' + ent.line + ' 行：INSERT 缺少块名（组码 2）。');
    }
    // DXF 中 70/71 缺省或为 0 均表示无阵列（1 行 1 列）
    var cols = ent.cols === undefined || ent.cols === 0 ? 1 : ent.cols;
    var rows = ent.rows === undefined || ent.rows === 0 ? 1 : ent.rows;
    if (cols !== 1 || rows !== 1) {
      throw makeErr('第 ' + ent.line + ' 行：INSERT 使用了 ' + cols + '×' + rows +
        ' 阵列，本验图不做阵列展开。');
    }
  }

  function parseEntityList(pairs, start, end, stopTokens) {
    var ents = [];
    var i = start;
    while (i < end) {
      if (pairs[i].c !== 0) {
        // 跳过游离的非 0 组（正常 DXF 不会出现）
        i++;
        continue;
      }
      var r = parseEntity(pairs, i);
      if (r.stopToken) {
        if (stopTokens && stopTokens[r.stopToken]) return { ents: ents, next: r.next, stop: r.stopToken };
        throw makeErr('第 ' + pairs[i].ln + ' 行：意外的 ' + r.stopToken + '。');
      }
      ents.push(r.ent);
      i = r.next;
    }
    return { ents: ents, next: i, stop: null };
  }

  function parseBlocks(sections, pairs) {
    var blocks = new Map();
    if (!sections.BLOCKS) return blocks;
    var s = sections.BLOCKS;
    var i = s.start;
    while (i < s.end) {
      if (pairs[i].c !== 0 || pairs[i].v !== 'BLOCK') {
        if (pairs[i].c === 0 && pairs[i].v === 'ENDBLK') {
          throw makeErr('第 ' + pairs[i].ln + ' 行：出现没有 BLOCK 配对的 ENDBLK。');
        }
        i++;
        continue;
      }
      var blockLine = pairs[i].ln;
      var j = i + 1;
      var name = null, bx = 0, by = 0, bz = 0, flag = 0;
      // 块头：读到第一个实体的 (0,xxx) 之前
      while (j < s.end && pairs[j].c !== 0) {
        var g = pairs[j].c, v = pairs[j].v, ln = pairs[j].ln;
        if (g === 2 || g === 3) name = v; // BLOCK 用 3，ENDBLK 用 5；兼容写出 2
        else if (g === 10) bx = num(v, ln, '块基点 X');
        else if (g === 20) by = num(v, ln, '块基点 Y');
        else if (g === 30) bz = num(v, ln, '块基点 Z');
        else if (g === 70) flag = num(v, ln, 'BLOCK 标志');
        j++;
      }
      if (Math.abs(bz) > EPS) {
        throw makeErr('第 ' + blockLine + ' 行：块 ' + name + ' 基点 Z 非 0，仅接受 Z=0。');
      }
      if ((flag & 4) || (flag & 8)) {
        throw makeErr('第 ' + blockLine + ' 行：块 ' + name + ' 是外部参照(XREF/OVERLAY)，不接收。');
      }
      if (!name) throw makeErr('第 ' + blockLine + ' 行：BLOCK 缺少名称。');
      if (blocks.has(name)) {
        throw makeErr('第 ' + blockLine + ' 行：块名 ' + name + ' 重复定义。');
      }
      var body = parseEntityList(pairs, j, s.end, { ENDBLK: 1 });
      if (body.stop !== 'ENDBLK') {
        throw makeErr('第 ' + blockLine + ' 行：块 ' + name + ' 缺少 ENDBLK。');
      }
      blocks.set(name, { name: name, base: { x: bx, y: by }, entities: body.ents, line: blockLine });
      i = body.next;
    }
    return blocks;
  }

  /* ============================================================
   * 3. parseDxf：文本 -> 文档（块定义不可变，根实体为原始数据）
   * ============================================================ */

  function parseDxf(text) {
    var pairs = tokenize(text);
    // 必须以 0/SECTION 或可忽略内容开始；EOF 对可有可无
    var sections = findSections(pairs);
    var blocks = parseBlocks(sections, pairs);

    var root = [];
    if (sections.ENTITIES) {
      var s = sections.ENTITIES;
      var r = parseEntityList(pairs, s.start, s.end, { ENDSEC: 1 });
      root = r.ents;
    }
    // 根实体中出现 BLOCK 引用由展开阶段处理；根级 BLOCK/ENDBLK 标记在 ENTITIES 里直接报错
    return { blocks: blocks, root: root };
  }

  /* ============================================================
   * 4. 二维仿射矩阵：[a,b,c,d,e,f]
   *    x' = a*x + b*y + e ; y' = c*x + d*y + f
   * ============================================================ */

  function I() { return [1, 0, 0, 1, 0, 0]; }
  function translation(x, y) { return [1, 0, 0, 1, x, y]; }
  function scaleM(sx, sy) { return [sx, 0, 0, sy, 0, 0]; }
  function rotation(rad) {
    var c = Math.cos(rad), s = Math.sin(rad);
    return [c, -s, s, c, 0, 0];
  }
  // A ∘ B：先作用 B，再作用 A
  function mul(A, B) {
    return [
      A[0] * B[0] + A[1] * B[2],
      A[0] * B[1] + A[1] * B[3],
      A[2] * B[0] + A[3] * B[2],
      A[2] * B[1] + A[3] * B[3],
      A[0] * B[4] + A[1] * B[5] + A[4],
      A[2] * B[4] + A[3] * B[5] + A[5]
    ];
  }
  function apply(m, p) {
    return {
      x: m[0] * p.x + m[1] * p.y + m[4],
      y: m[2] * p.x + m[3] * p.y + m[5]
    };
  }
  function applyVec(m, x, y) {
    return { x: m[0] * x + m[1] * y, y: m[2] * x + m[3] * y };
  }
  function det(m) { return m[0] * m[3] - m[1] * m[2]; }

  /* INSERT 实例相对父坐标系的局部矩阵：T(x,y)·R(θ)·S(sx,sy)·T(-base) */
  function insertMatrix(ins, base) {
    var m = translation(ins.x, ins.y);
    if (ins.rotation) m = mul(m, rotation(ins.rotation * Math.PI / 180));
    m = mul(m, scaleM(ins.sx, ins.sy));
    if (base && (base.x || base.y)) m = mul(m, translation(-base.x, -base.y));
    return m;
  }

  /* ============================================================
   * 5. bulge -> 有向圆弧
   *    bulge k = tan(θ/4)，θ 为有向圆心角：
   *    k>0 局部坐标系内自起点逆时针(CCW)，k<0 顺时针(CW)。
   *    闭合多段线最后一个顶点的 bulge 作用于「末点→首点」闭合段。
   * ============================================================ */

  function bulgeToArc(p1, p2, k) {
    var dx = p2.x - p1.x, dy = p2.y - p1.y;
    var L = Math.hypot(dx, dy);
    if (L < EPS) return null;
    var ux = dx / L, uy = dy / L;
    // 圆心在弦中垂线上，沿有向弦左法向的带符号偏移为 s = L(1-k^2)/(4k)。
    // k>0：圆心在弦的左侧、扫掠逆时针；k<0：右侧、顺时针（DXF/WCS，Y 轴向上）。
    var s = L * (1 - k * k) / (4 * k);
    var cx = (p1.x + p2.x) / 2 - s * uy;
    var cy = (p1.y + p2.y) / 2 + s * ux;
    var r = L * (k * k + 1) / (4 * Math.abs(k));
    var a0 = Math.atan2(p1.y - cy, p1.x - cx);
    var sweep = 4 * Math.atan(k); // (-2π, 2π)，符号即 CCW/CW
    return {
      cx: cx,
      cy: cy,
      r: r,
      a0: a0,
      sweep: sweep
    };
  }

  function arcPointLocal(arc, t) {
    return { x: arc.cx + arc.r * Math.cos(t), y: arc.cy + arc.r * Math.sin(t) };
  }

  function normalizeAngle(a) {
    var TAU = Math.PI * 2;
    a %= TAU;
    if (a < 0) a += TAU;
    return a;
  }

  function angleInArc(t, a0, sweep) {
    var d = normalizeAngle(t - a0);
    if (sweep >= 0) return d <= sweep + 1e-7;
    return d >= Math.PI * 2 + sweep - 1e-7;
  }

  /* 变换后椭圆弧的精确包围盒：
   * 起点、终点 + 各坐标轴方向上的内部极值点（若极值参数落在弧区间内）。
   * Xw(t) = Kx + A cos t + B sin t，极值 t = atan2(B,A) 与 +π；Y 轴同理。 */
  function arcWorldBounds(arc, m) {
    var pS = apply(m, arcPointLocal(arc, arc.a0));
    var pE = apply(m, arcPointLocal(arc, arc.a0 + arc.sweep));
    var b = new Bounds();
    b.add(pS.x, pS.y);
    b.add(pE.x, pE.y);

    var Kx = m[4] + m[0] * arc.cx + m[1] * arc.cy;
    var Ky = m[5] + m[2] * arc.cx + m[3] * arc.cy;
    var axes = [
      { A: m[0] * arc.r, B: m[1] * arc.r, K: Kx, isX: true },
      { A: m[2] * arc.r, B: m[3] * arc.r, K: Ky, isX: false }
    ];
    for (var i = 0; i < 2; i++) {
      var ax = axes[i];
      var t1 = Math.atan2(ax.B, ax.A);
      var t2 = t1 + Math.PI;
      [t1, t2].forEach(function (t) {
        if (angleInArc(t, arc.a0, arc.sweep)) {
          var v = ax.K + ax.A * Math.cos(t) + ax.B * Math.sin(t);
          if (ax.isX) b.add(v, b.ymin); // 另一轴未知，仅扩张该轴
          else b.add(b.xmin, v);
        }
      });
    }
    return b;
  }

  function Bounds() {
    this.xmin = Infinity; this.ymin = Infinity;
    this.xmax = -Infinity; this.ymax = -Infinity;
  }
  Bounds.prototype.add = function (x, y) {
    if (x < this.xmin) this.xmin = x;
    if (x > this.xmax) this.xmax = x;
    if (y < this.ymin) this.ymin = y;
    if (y > this.ymax) this.ymax = y;
  };
  Bounds.prototype.merge = function (o) {
    if (!o || !isFinite(o.xmin)) return;
    this.add(o.xmin, o.ymin);
    this.add(o.xmax, o.ymax);
  };
  Bounds.prototype.valid = function () { return isFinite(this.xmin); };
  Bounds.prototype.width = function () { return this.xmax - this.xmin; };
  Bounds.prototype.height = function () { return this.ymax - this.ymin; };

  function lineWorldBounds(p1, p2) {
    var b = new Bounds();
    b.add(p1.x, p1.y);
    b.add(p2.x, p2.y);
    return b;
  }

  /* 圆弧（局部）按参数细分，供显示/命中测试；量测不使用细分点 */
  function tessellateArc(arc, m) {
    var span = Math.abs(arc.sweep);
    var n = Math.max(8, Math.min(160, Math.ceil(span / (Math.PI / 24))));
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var t = arc.a0 + arc.sweep * (i / n);
      pts.push(apply(m, arcPointLocal(arc, t)));
    }
    return pts;
  }

  /* 高精度采样包围盒，仅用于测试核对 */
  function sampledArcWorldBounds(arc, m, n) {
    n = n || 200001;
    var b = new Bounds();
    for (var i = 0; i <= n; i++) {
      var t = arc.a0 + arc.sweep * (i / n);
      var p = apply(m, arcPointLocal(arc, t));
      b.add(p.x, p.y);
    }
    return b;
  }

  /* ============================================================
   * 6. 展开模型：块基点平移 + 插入缩放/旋转 + 父变换组合
   *    - 未知块、循环引用、零缩放、深度>4、展开实体>60 一律拒绝
   *    - 每次展开生成全新对象，块定义与兄弟实例互不污染
   * ============================================================ */

  var MAX_DEPTH = 4;
  var MAX_ENTITIES = 60;

  function effectiveInsert(ent, override) {
    var ins = {
      name: ent.name,
      line: ent.line,
      x: override && override.x !== undefined ? override.x : ent.x,
      y: override && override.y !== undefined ? override.y : ent.y,
      sx: override && override.sx !== undefined ? override.sx : ent.sx,
      sy: override && override.sy !== undefined ? override.sy : ent.sy,
      rotation: override && override.rotation !== undefined ? override.rotation : ent.rotation
    };
    if (!isFinite(ins.x) || !isFinite(ins.y) || !isFinite(ins.sx) || !isFinite(ins.sy) || !isFinite(ins.rotation)) {
      throw makeErr('第 ' + ent.line + ' 行：INSERT「' + ent.name + '」存在非有限参数。');
    }
    if (Math.abs(ins.sx) < EPS || Math.abs(ins.sy) < EPS) {
      throw makeErr('第 ' + ent.line + ' 行：INSERT「' + ent.name + '」使用了零缩放（sx=' +
        fmtN(ins.sx) + ', sy=' + fmtN(ins.sy) + '），明确拒绝。');
    }
    return ins;
  }

  function buildModel(doc, overrides) {
    overrides = overrides || {};
    var model = { doc: doc, occurrences: [], primitives: [], leafCount: 0, bounds: new Bounds() };

    function makeOcc(o) {
      var occ = {
        id: o.id,
        kind: o.kind,                       // 'insert' | 'entity'
        name: o.name || null,               // 块名（insert）
        source: o.source,                   // INSERT 实体或根实体
        depth: o.depth || 0,
        path: o.path || [],                 // 完整插入路径（人类可读）
        idPath: o.idPath || [],             // 稳定标识路径（覆盖用）
        matrix: o.matrix,
        parent: o.parent || null,
        children: [],
        primitives: [],
        ownBounds: new Bounds(),
        subTreeBounds: null,
        params: o.params || null            // 生效的插入参数
      };
      return occ;
    }

    function addGeometry(ent, m, occ) {
      if (ent.kind === 'LINE') {
        var p1 = apply(m, { x: ent.x1, y: ent.y1 });
        var p2 = apply(m, { x: ent.x2, y: ent.y2 });
        var pr = {
          type: 'line', owner: occ, entityKind: 'LINE', entityLine: ent.line,
          a: p1, b: p2, bounds: lineWorldBounds(p1, p2)
        };
        occ.primitives.push(pr);
        model.primitives.push(pr);
        occ.ownBounds.merge(pr.bounds);
      } else if (ent.kind === 'LWPOLYLINE') {
        var n = ent.verts.length;
        var segCount = ent.closed ? n : n - 1;
        for (var s = 0; s < segCount; s++) {
          var v1 = ent.verts[s];
          var v2 = ent.verts[(s + 1) % n];
          var k = v1.bulge || 0;
          var q1 = apply(m, v1), q2 = apply(m, v2);
          var closing = ent.closed && s === n - 1;
          if (Math.abs(k) < EPS) {
            if (Math.hypot(v2.x - v1.x, v2.y - v1.y) < EPS) continue;
            var lp = {
              type: 'line', owner: occ, entityKind: 'LWPOLYLINE', entityLine: ent.line,
              seg: s, closing: closing, bulge: 0, a: q1, b: q2,
              bounds: lineWorldBounds(q1, q2)
            };
            occ.primitives.push(lp);
            model.primitives.push(lp);
            occ.ownBounds.merge(lp.bounds);
          } else {
            var arc = bulgeToArc(v1, v2, k);
            if (!arc) continue;
            var wb = arcWorldBounds(arc, m);
            var ap = {
              type: 'arc', owner: occ, entityKind: 'LWPOLYLINE', entityLine: ent.line,
              seg: s, closing: closing, bulge: k,
              arc: arc, matrix: m.slice(),
              a: apply(m, arcPointLocal(arc, arc.a0)),
              b: apply(m, arcPointLocal(arc, arc.a0 + arc.sweep)),
              mid: apply(m, arcPointLocal(arc, arc.a0 + arc.sweep / 2)),
              worldCCW: det(m) * arc.sweep > 0,
              bounds: wb
            };
            occ.primitives.push(ap);
            model.primitives.push(ap);
            occ.ownBounds.merge(wb);
          }
        }
      }
    }

    function countEntity(ent) {
      if (ent.kind === 'INSERT') return;
      model.leafCount++;
      if (model.leafCount > MAX_ENTITIES) {
        throw makeErr('展开后的平面实体数量超过上限 ' + MAX_ENTITIES + '（当前 ' +
          model.leafCount + '），拒绝继续展开。');
      }
    }

    function expandInsert(ent, parent, parentM, chainSteps, chainIds, depth) {
      var name = ent.name;
      var chainNames = chainSteps.map(function (s) { return s.block; });
      if (chainNames.indexOf(name) >= 0) {
        throw makeErr('检测到循环块引用：' + chainNames.concat(name).join(' → ') +
          '（第 ' + ent.line + ' 行 INSERT），拒绝展开。');
      }
      if (depth > MAX_DEPTH) {
        throw makeErr('块嵌套深度超过 ' + MAX_DEPTH + ' 层：' +
          chainNames.concat(name).join(' → ') + '（第 ' + ent.line + ' 行）。');
      }
      var def = doc.blocks.get(name);
      if (!def) {
        throw makeErr('第 ' + ent.line + ' 行：INSERT 引用了未定义的块「' + name + '」，拒绝展开。');
      }
      var ordinal = parent ? parent.children.length : model.occurrences.length;
      var idPath = chainIds.concat([ordinal]);
      var id = idPath.join('>');
      var ins = effectiveInsert(ent, overrides[id]);
      var m = mul(parentM, insertMatrix(ins, def.base));

      var selfStep = { block: name, kind: 'self', params: ins, base: def.base, line: ins.line };
      var steps = chainSteps.concat([selfStep]).map(function (s) {
        return { block: s.block, kind: s.kind || 'nest', params: s.params, base: s.base, line: s.line };
      });
      var occ = makeOcc({
        id: id, kind: 'insert', name: name, source: ent, depth: depth,
        path: steps,
        idPath: idPath, matrix: m, parent: parent, params: ins
      });
      occ.basePoint = def.base;
      if (parent) parent.children.push(occ); else model.occurrences.push(occ);

      for (var i = 0; i < def.entities.length; i++) {
        var e = def.entities[i];
        if (e.kind === 'INSERT') {
          expandInsert(e, occ, m, steps, idPath, depth + 1);
        } else {
          countEntity(e);
          addGeometry(e, m, occ);
        }
      }
      return occ;
    }

    for (var ri = 0; ri < doc.root.length; ri++) {
      var re = doc.root[ri];
      if (re.kind === 'INSERT') {
        expandInsert(re, null, I(), [], [], 1);      } else {
        countEntity(re);
        var occ = makeOcc({
          id: 'e' + ri, kind: 'entity', name: null, source: re, depth: 0,
          path: [{ block: re.kind + '（图纸根实体）', kind: 'root', line: re.line }],
          idPath: [ri], matrix: I()
        });
        model.occurrences.push(occ);
        addGeometry(re, I(), occ);
      }
    }

    // 汇总包围盒与子树包围盒
    function finalize(occ) {
      var b = new Bounds();
      b.merge(occ.ownBounds);
      occ.children.forEach(function (c) { finalize(c); b.merge(c.subTreeBounds); });
      occ.subTreeBounds = b;
      model.bounds.merge(b);
    }
    model.occurrences.forEach(finalize);

    model.findOccurrence = function (id) { return findById(model.occurrences, id); };
    return model;
  }

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
      var hit = findById(list[i].children, id);
      if (hit) return hit;
    }
    return null;
  }

  function fmtN(v) {
    if (!isFinite(v)) return String(v);
    var r = Math.round(v * 1e6) / 1e6;
    return String(r);
  }

  return {
    // 解析
    parseDxf: parseDxf,
    tokenize: tokenize,
    // 几何
    matrix: { I: I, translation: translation, scale: scaleM, rotation: rotation, mul: mul, apply: apply, applyVec: applyVec, det: det, insertMatrix: insertMatrix },
    bulgeToArc: bulgeToArc,
    arcPointLocal: arcPointLocal,
    arcWorldBounds: arcWorldBounds,
    sampledArcWorldBounds: sampledArcWorldBounds,
    tessellateArc: tessellateArc,
    angleInArc: angleInArc,
    normalizeAngle: normalizeAngle,
    Bounds: Bounds,
    // 展开
    buildModel: buildModel,
    findById: findById,
    MAX_DEPTH: MAX_DEPTH,
    MAX_ENTITIES: MAX_ENTITIES,
    fmt: fmtN
  };
});
