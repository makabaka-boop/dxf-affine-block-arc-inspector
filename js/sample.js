/* sample.js — 内置验图示例 DXF 生成（浏览器端）
 * 覆盖：非零块基点、两层嵌套、负比例镜像、非均匀缩放+旋转、跨象限优弧、闭合段 bulge。 */
(function () {
  'use strict';
  const W = window.DxfWriter;

  window.buildSampleDxf = function () {
    const w = new W();
    w.begin();
    w.startBlocks();

    /* KNOB：非零基点 (0.5,0.5) 的小旋钮
     *   弦 LINE (0,0)-(1,0)；下半圆 bulge=1；左侧小柄 LINE (0,0)-(0,-0.4)
     *   镜像后小柄从左侧翻到右侧，便于肉眼识别实例差异。 */
    w.startBlock('KNOB', 0.5, 0.5);
    w.line(0, 0, 1, 0);
    w.lwpoly([{ x: 0, y: 0, bulge: 1 }, { x: 1, y: 0 }], false);
    w.line(0, 0, 0, -0.4);
    w.endBlock();

    /* CABINET：30×14 柜体（闭合 LWPOLYLINE）+ bulge=2 跨象限优弧大拉手
     *   两个旋钮：右侧一个以 sx=-1 镜像插入（嵌套层负比例）。 */
    w.startBlock('CABINET', 0, 0);
    w.lwpoly([
      { x: 0, y: 0 }, { x: 30, y: 0 },
      { x: 30, y: 14 }, { x: 0, y: 14 }
    ], true);
    // 大拉手：(8,3)->(22,3) 优弧 253.74°，含 X 左/右与 Y 顶/底极值
    w.lwpoly([{ x: 8, y: 3, bulge: 2 }, { x: 22, y: 3 }], false);
    w.insert('KNOB', 7, 7, 1, 1, 0);
    w.insert('KNOB', 23, 7, -1, 1, 0);
    w.endBlock();

    /* DOOR：门扇直线 + bulge=-0.5 的上开小弧（CW，弧顶在弦上方 (5,2.5)） */
    w.startBlock('DOOR', 0, 0);
    w.line(0, 0, 10, 0);
    w.lwpoly([{ x: 0, y: 0, bulge: -0.5 }, { x: 10, y: 0 }], false);
    w.endBlock();

    w.endBlocks();
    w.startEntities();

    // 地面参考线（图纸根实体，无块包裹）
    w.line(-5, 0, 80, 0);

    // 门：原始 / 旋转 90° / X 镜像 / 非均匀 2×0.5 + 15°
    w.insert('DOOR', 10, 0, 1, 1, 0);
    w.insert('DOOR', 40, 0, 1, 1, 90);
    w.insert('DOOR', 60, 10, -1, 1, 0);
    w.insert('DOOR', 10, 18, 2, 0.5, 15);

    // 柜：原始；另一台 Y 镜像（整个子树连同嵌套旋钮一起翻转）
    w.insert('CABINET', 5, 30, 1, 1, 0);
    w.insert('CABINET', 50, 55, 1, -1, 0);

    w.endEntities();
    return w.render();
  };
})();
