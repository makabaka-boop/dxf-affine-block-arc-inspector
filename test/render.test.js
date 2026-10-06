import test from 'node:test';
import assert from 'node:assert/strict';
import { geometryPaths } from '../src/ui/render.js';
import { arcFromBulge, pointAt } from '../src/geometry/arc.js';
import { applyPoint } from '../src/geometry/transform.js';

function polylineArcExpansion() {
  const arc = arcFromBulge({ x: 0, y: 0 }, { x: 1, y: 0 }, 0.5);
  const leaf = {
    id: 'leaf:test',
    kind: 'leaf',
    entityKind: 'polyline',
    path: [],
    closed: false,
    vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    segments: [{
      id: 'leaf:test/segment-0',
      index: 0,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      bulge: 0.5,
      arc,
      matrix: [1, 0, 0, 1, 0, 0],
      orientation: arc.direction,
      bbox: { minX: 0, minY: -0.25, maxX: 1, maxY: 0 },
      closing: false,
    }],
    bbox: { minX: 0, minY: -0.25, maxX: 1, maxY: 0 },
  };
  return { nodes: [leaf], leafNodes: [leaf], insertNodes: [], segments: leaf.segments, bbox: leaf.bbox, leafCount: 1 };
}

test('geometry renderer emits an elliptical arc rather than a chord polyline', () => {
  const paths = geometryPaths(polylineArcExpansion(), { scale: 1, panX: 0, panY: 0 });
  assert.match(paths[0].d, /^M 0 0 A /);
  assert.match(paths[0].d, / 1 0$/);
  assert.doesNotMatch(paths[0].d, / L /);
});

test('identity-transformed arc midpoint lies on the parametric circle', () => {
  const arc = arcFromBulge({ x: 0, y: 0 }, { x: 2, y: 0 }, 1);
  const mid = applyPoint([1, 0, 0, 1, 0, 0], pointAt(arc, 0.5));
  assert.ok(mid.y > 0.9);
  assert.equal(Math.hypot(mid.x - arc.center.x, mid.y - arc.center.y), arc.radius);
});
