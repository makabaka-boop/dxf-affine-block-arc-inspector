import { allSegments } from '../dxf/expand.js';
import { applyPoint, determinant, multiply } from '../geometry/transform.js';
import { ellipseParameters } from '../geometry/arc.js';

function viewMatrix(view) {
  return [view.scale, 0, 0, -view.scale, view.panX, view.panY];
}

function toScreen(view, point) {
  return applyPoint(viewMatrix(view), point);
}

function number(value) {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function pointCommand(view, point) {
  const p = toScreen(view, point);
  return `${number(p.x)} ${number(p.y)}`;
}

function arcCommand(view, segment) {
  const screenTransform = multiply(viewMatrix(view), segment.matrix);
  const ellipse = ellipseParameters(screenTransform);
  const orientation = segment.arc.direction * Math.sign(determinant(screenTransform));
  const sweep = orientation > 0 ? 1 : 0;
  const large = segment.arc.sweep > Math.PI ? 1 : 0;
  const end = pointCommand(view, segment.end);
  return `A ${number(ellipse.rx)} ${number(ellipse.ry)} ${number(ellipse.rotation)} ${large} ${sweep} ${end}`;
}

export function geometryPaths(expansion, view) {
  const paths = [];

  for (const leaf of expansion.leafNodes) {
    if (leaf.entityKind === 'line') {
      paths.push({
        id: leaf.id,
        kind: 'line',
        leaf,
        d: `M ${pointCommand(view, leaf.start)} L ${pointCommand(view, leaf.end)}`,
      });
      continue;
    }

    let d = `M ${pointCommand(view, leaf.vertices[0])}`;
    for (const segment of leaf.segments) {
      d += segment.arc ? ` ${arcCommand(view, segment)}` : ` L ${pointCommand(view, segment.end)}`;
    }
    if (leaf.closed) d += ' Z';
    paths.push({ id: leaf.id, kind: 'polyline', leaf, d });
  }

  return paths;
}

export function screenPointFromWorld(view, point) {
  return toScreen(view, point);
}

export function selectableSegments(expansion, view) {
  return allSegments(expansion).map((segment) => ({
    segment,
    start: toScreen(view, segment.start),
    end: toScreen(view, segment.end),
  }));
}
