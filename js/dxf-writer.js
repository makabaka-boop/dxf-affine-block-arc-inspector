/*!
 * dxf-writer.js — 仅用于生成示例与测试 ASCII DXF，页面本身不依赖。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DxfWriter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function DxfWriter() {
    this.pairs = [];
  }

  DxfWriter.prototype.pair = function (code, value) {
    if (value === undefined || value === null) value = '';
    this.pairs.push([code, String(value)]);
    return this;
  };

  DxfWriter.prototype.begin = function () {
    this.pair(0, 'SECTION').pair(2, 'HEADER')
      .pair(9, '$ACADVER').pair(1, 'AC1027')
      .pair(0, 'ENDSEC');
    return this;
  };

  DxfWriter.prototype.startBlocks = function () {
    this.pair(0, 'SECTION').pair(2, 'BLOCKS');
    return this;
  };
  DxfWriter.prototype.endBlocks = function () {
    this.pair(0, 'ENDSEC');
    return this;
  };

  DxfWriter.prototype.startEntities = function () {
    this.pair(0, 'SECTION').pair(2, 'ENTITIES');
    return this;
  };
  DxfWriter.prototype.endEntities = function () {
    this.pair(0, 'ENDSEC').pair(0, 'EOF');
    return this;
  };

  DxfWriter.prototype.startBlock = function (name, baseX, baseY) {
    this.pair(0, 'BLOCK')
      .pair(5, '0')
      .pair(100, 'AcDbEntity')
      .pair(8, '0')
      .pair(100, 'AcDbBlockBegin')
      .pair(2, name)
      .pair(70, 0)
      .pair(10, baseX || 0).pair(20, baseY || 0).pair(30, 0)
      .pair(3, name).pair(1, '');
    return this;
  };
  DxfWriter.prototype.endBlock = function () {
    this.pair(0, 'ENDBLK')
      .pair(5, '0')
      .pair(100, 'AcDbEntity')
      .pair(8, '0')
      .pair(100, 'AcDbBlockEnd');
    return this;
  };

  DxfWriter.prototype.line = function (x1, y1, x2, y2) {
    this.pair(0, 'LINE').pair(5, '0').pair(100, 'AcDbEntity').pair(8, '0')
      .pair(100, 'AcDbLine')
      .pair(10, x1).pair(20, y1).pair(30, 0)
      .pair(11, x2).pair(21, y2).pair(31, 0);
    return this;
  };

  DxfWriter.prototype.lwpoly = function (verts, closed) {
    this.pair(0, 'LWPOLYLINE').pair(5, '0')
      .pair(100, 'AcDbEntity').pair(8, '0')
      .pair(100, 'AcDbPolyline')
      .pair(90, verts.length)
      .pair(70, closed ? 1 : 0);
    verts.forEach(function (v) {
      this.pair(10, v.x).pair(20, v.y).pair(42, v.bulge || 0);
    }, this);
    return this;
  };

  DxfWriter.prototype.insert = function (name, x, y, sx, sy, rotation) {
    this.pair(0, 'INSERT').pair(5, '0')
      .pair(100, 'AcDbEntity').pair(8, '0')
      .pair(100, 'AcDbBlockReference')
      .pair(2, name)
      .pair(10, x || 0).pair(20, y || 0).pair(30, 0)
      .pair(41, sx === undefined ? 1 : sx)
      .pair(42, sy === undefined ? 1 : sy)
      .pair(50, rotation || 0)
      .pair(70, 0).pair(71, 0)
      .pair(44, 0).pair(45, 0);
    return this;
  };

  DxfWriter.prototype.raw = function (code, value) {
    return this.pair(code, value);
  };

  DxfWriter.prototype.render = function () {
    return this.pairs.map(function (p) {
      var c = String(p[0]);
      while (c.length < 3) c = ' ' + c;
      return c + '\r\n' + p[1];
    }).join('\r\n') + '\r\n';
  };

  return DxfWriter;
});
