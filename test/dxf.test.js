import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDxf } from '../src/dxf/parser.js';
import { expandDrawing, ExpansionError } from '../src/dxf/expand.js';
import { arcFromBulge, arcBounds } from '../src/geometry/arc.js';
import { applyPoint, insertionTransform } from '../src/geometry/transform.js';

function pairsText(pairs) {
  return pairs.map(([code, value]) => `${String(code).padStart(3)}\n${value}`).join('\n') + '\n  0\nEOF\n';
}

function section(name, body) {
  return [[0, 'SECTION'], [2, name], ...body, [0, 'ENDSEC']];
}

function lineEntity(start, end) {
  return [
    [0, 'LINE'],
    [10, start.x], [20, start.y], [30, 0],
    [11, end.x], [21, end.y], [31, 0],
  ];
}

function lwpolylineEntity(vertices, closed = false) {
  const pairs = [[0, 'LWPOLYLINE'], [90, vertices.length], [70, closed ? 1 : 0]];
  for (const v of vertices) {
    pairs.push([10, v.x], [20, v.y]);
    if (v.bulge !== undefined) pairs.push([42, v.bulge]);
  }
  return pairs;
}

function insertEntity(name, point, sx = 1, sy = 1, rotationDeg = 0) {
  return [
    [0, 'INSERT'], [2, name],
    [10, point.x], [20, point.y], [30, 0],
    [41, sx], [42, sy], [43, 1], [50, rotationDeg],
  ];
}

function blockEntity(name, base, entities) {
  return [
    [0, 'BLOCK'], [2, name], [70, 0],
    [10, base.x], [20, base.y], [30, 0],
    ...entities,
    [0, 'ENDBLK'],
  ];
}

function flattenPairs(value) {
  return value.flatMap((item) => (Array.isArray(item[0]) ? flattenPairs(item) : [item]));
}

function dxfWith(blocks = [], entities = []) {
  return pairsText(flattenPairs([
    ...section('HEADER', [[9, '$ACADVER'], [1, 'AC1027']]),
    ...section('BLOCKS', blocks),
    ...section('ENTITIES', entities),
  ]));
}

test('non-zero block base is translated before insertion scaling', () => {
  const dxf = dxfWith(
    [blockEntity('MARK', { x: 10, y: 20 }, [lineEntity({ x: 10, y: 20 }, { x: 12, y: 23 })])],
    [insertEntity('MARK', { x: 5, y: -5 }, 2, 3)],
  );
  const drawing = parseDxf(dxf);
  const result = expandDrawing(drawing);
  assert.equal(result.leafCount, 1);
  assert.deepEqual(result.leafNodes[0].start, { x: 5, y: -5 });
  assert.deepEqual(result.leafNodes[0].end, { x: 9, y: 4 });
});

test('two nested inserts combine child and parent affine transforms', () => {
  const dxf = dxfWith(
    [
      blockEntity('INNER', { x: 1, y: 0 }, [lineEntity({ x: 1, y: 0 }, { x: 2, y: 0 })]),
      blockEntity('OUTER', { x: 0, y: 0 }, [insertEntity('INNER', { x: 0, y: 0 }, -1, 1)]),
    ],
    [insertEntity('OUTER', { x: 10, y: 4 }, 1, 1)],
  );
  const result = expandDrawing(parseDxf(dxf));
  const inserts = result.insertNodes;
  assert.deepEqual(inserts.map((node) => node.path.length), [1, 2]);
  assert.deepEqual(result.leafNodes[0].start, { x: 10, y: 4 });
  assert.deepEqual(result.leafNodes[0].end, { x: 9, y: 4 });
  assert.equal(result.leafNodes[0].path[1].name, 'INNER');
});

test('closed LWPOLYLINE bulge on final vertex creates the closing parametric arc', () => {
  const dxf = dxfWith(
    [],
    [lwpolylineEntity([
      { x: 0, y: 0, bulge: 0 },
      { x: 1, y: 0, bulge: 0.5 },
    ], true)],
  );
  const result = expandDrawing(parseDxf(dxf));
  const leaf = result.leafNodes[0];
  assert.equal(leaf.closed, true);
  assert.equal(leaf.segments.length, 2);
  const closing = leaf.segments[1];
  assert.equal(closing.closing, true);
  assert.ok(closing.arc);
  assert.deepEqual(closing.start, { x: 1, y: 0 });
  assert.deepEqual(closing.end, { x: 0, y: 0 });
  assert.equal(closing.arc.center.y, -0.375);
});

test('negative / non-uniform scale retains arc and includes interior extrema', () => {
  const arc = arcFromBulge({ x: 1, y: 0 }, { x: 0, y: 0 }, 0.5);
  const bounds = arcBounds(arc, [-2, 0, 0, 3, 0, 0]);
  assert.equal(bounds.minX, -2.25);
  assert.ok(Math.abs(bounds.maxX + 1.44) < 1e-10);
  assert.equal(bounds.minY, -2.88);
  assert.equal(bounds.maxY, 0);
});

test('major arc crossing quadrants has endpoint and internal bounds', () => {
  const arc = arcFromBulge({ x: 0, y: 1 }, { x: 1, y: 0 }, -1.5);
  assert.ok(arc.sweep > Math.PI);
  const bounds = arcBounds(arc, [1, 0, 0, 1, 0, 0]);
  assert.ok(bounds.minX < 0);
  assert.ok(bounds.maxY > 1);
});

test('one-instance scale override does not change a shared block instance', () => {
  const dxf = dxfWith(
    [blockEntity('SHARED', { x: 1, y: 1 }, [lineEntity({ x: 1, y: 1 }, { x: 3, y: 2 })])],
    [insertEntity('SHARED', { x: 0, y: 0 }), insertEntity('SHARED', { x: 20, y: 20 })],
  );
  const drawing = parseDxf(dxf);
  const initial = expandDrawing(drawing);
  const overrides = new Map([[initial.insertNodes[0].overrideKey, { sx: 2, sy: 2 }]]);
  const changed = expandDrawing(drawing, overrides);
  assert.deepEqual(changed.leafNodes[0].end, { x: 4, y: 2 });
  assert.deepEqual(changed.leafNodes[1].end, { x: 22, y: 21 });
});

test('unknown block, zero scale and circular references are refused', () => {
  const unknown = parseDxf(dxfWith([], [insertEntity('MISSING', { x: 0, y: 0 })]));
  assert.throws(() => expandDrawing(unknown), ExpansionError);

  const zeroDxf = dxfWith(
    [blockEntity('A', { x: 0, y: 0 }, [lineEntity({x:0,y:0},{x:1,y:0})])],
    [insertEntity('A', { x: 0, y: 0 })],
  );
  assert.throws(() => parseDxf(dxfWith(
    [blockEntity('A', { x: 0, y: 0 }, [lineEntity({x:0,y:0},{x:1,y:0})])],
    [insertEntity('A', { x: 0, y: 0 }, 0, 1)],
  )), /[Zz]ero/);
  const zeroDrawing = parseDxf(zeroDxf);
  const zeroNode = expandDrawing(zeroDrawing);
  const zeroOverrides = new Map([[zeroNode.insertNodes[0].overrideKey, { sx: 0, sy: 1 }]]);
  assert.throws(() => expandDrawing(zeroDrawing, zeroOverrides), /Zero/);

  const cyclic = parseDxf(dxfWith(
    [
      blockEntity('A', { x: 0, y: 0 }, [insertEntity('B', { x: 0, y: 0 })]),
      blockEntity('B', { x: 0, y: 0 }, [insertEntity('A', { x: 0, y: 0 })]),
    ],
    [insertEntity('A', { x: 0, y: 0 })],
  ));
  assert.throws(() => expandDrawing(cyclic), /Circular/);
});

test('block nesting deeper than four levels is refused', () => {
  const blocks = [];
  for (let i = 1; i <= 5; i++) {
    const child = i === 5 ? lineEntity({ x: 0, y: 0 }, { x: 1, y: 0 }) : insertEntity(`B${i + 1}`, { x: 0, y: 0 });
    blocks.push(blockEntity(`B${i}`, { x: 0, y: 0 }, [child]));
  }
  const drawing = parseDxf(dxfWith(blocks, [insertEntity('B1', { x: 0, y: 0 })]));
  assert.throws(() => expandDrawing(drawing), /4-level/);
});

test('parser rejects non-planar Z and unsupported entities', () => {
  assert.throws(() => parseDxf(dxfWith([], [[[0, 'CIRCLE'], [10, 0], [20, 0], [40, 1]]])), /Unsupported/);
  assert.throws(
    () => parseDxf(pairsText([
      ...section('ENTITIES', [[0, 'LINE'], [10, 0], [20, 0], [30, 1], [11, 1], [21, 0], [31, 0]]),
    ])),
    /Z = 0/,
  );
});

test('insertion transform formula matches DXF rotation/scale/base semantics', () => {
  const m = insertionTransform(
    { x: 4, y: 5, rotationDeg: 90 },
    { x: 1, y: 2 },
    2,
    3,
  );
  // base maps to insertion point
  assert.deepEqual(applyPoint(m, { x: 1, y: 2 }), { x: 4, y: 5 });
});
