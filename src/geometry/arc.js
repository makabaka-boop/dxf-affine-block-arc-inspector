import { applyPoint } from './transform.js';

const TWO_PI = Math.PI * 2;

export function arcFromBulge(start, end, bulge) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (!Number.isFinite(chord) || chord === 0) {
    throw new Error('Bulge arc requires two distinct endpoints');
  }
  if (!Number.isFinite(bulge) || bulge === 0) {
    throw new Error('Bulge arc requires a non-zero finite bulge');
  }

  const absBulge = Math.abs(bulge);
  const radius = (chord * (bulge * bulge + 1)) / (4 * absBulge);
  const sagitta = (chord * absBulge) / 2;
  const nx = -dy / chord;
  const ny = dx / chord;
  const centerSign = bulge > 0 ? 1 : -1;
  const centerDistance = centerSign * (radius - sagitta);
  const center = {
    x: (start.x + end.x) / 2 + nx * centerDistance,
    y: (start.y + end.y) / 2 + ny * centerDistance,
  };

  // In DXF Cartesian Y-up coordinates, positive bulge traverses clockwise.
  const direction = bulge > 0 ? -1 : 1;
  const sweep = 4 * Math.atan(absBulge);
  const startTheta = Math.atan2(start.y - center.y, start.x - center.x);
  return {
    center,
    radius,
    bulge,
    direction,
    sweep,
    startTheta,
    endTheta: startTheta + direction * sweep,
  };
}

export function pointAt(arc, t) {
  const theta = arc.startTheta + arc.direction * arc.sweep * t;
  return {
    x: arc.center.x + arc.radius * Math.cos(theta),
    y: arc.center.y + arc.radius * Math.sin(theta),
  };
}

function wrapped0To2Pi(angle) {
  const result = angle % TWO_PI;
  return result < 0 ? result + TWO_PI : result;
}

function containsAngle(arc, theta) {
  const candidate = wrapped0To2Pi(theta);
  const start = wrapped0To2Pi(arc.startTheta);
  let travelled = (candidate - start) * arc.direction;
  if (travelled < 0) travelled += TWO_PI;
  return travelled <= arc.sweep + 1e-10;
}

export function transformedPointAt(arc, m, t) {
  return applyPoint(m, pointAt(arc, t));
}

// Exact extrema of M * (centre + r(cos theta,sin theta)).
// Tangent extrema in both axes are added together with both endpoints.
export function arcBounds(arc, m) {
  const [a, b, c, d] = m;
  const r = arc.radius;
  const candidates = [arc.startTheta, arc.endTheta];

  const xCandidate = Math.atan2(c, a);
  const yCandidate = Math.atan2(d, b);
  for (const theta of [xCandidate, xCandidate + Math.PI, yCandidate, yCandidate + Math.PI]) {
    if (containsAngle(arc, theta)) candidates.push(theta);
  }

  const points = candidates.map((theta) =>
    applyPoint(m, {
      x: arc.center.x + r * Math.cos(theta),
      y: arc.center.y + r * Math.sin(theta),
    }),
  );

  let minX = points[0].x;
  let maxX = minX;
  let minY = points[0].y;
  let maxY = minY;
  const extrema = { minX: points[0], maxX: points[0], minY: points[0], maxY: points[0] };

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) {
      minX = p.x;
      extrema.minX = p;
    }
    if (p.x > maxX) {
      maxX = p.x;
      extrema.maxX = p;
    }
    if (p.y < minY) {
      minY = p.y;
      extrema.minY = p;
    }
    if (p.y > maxY) {
      maxY = p.y;
      extrema.maxY = p;
    }
  }

  return { minX, minY, maxX, maxY, extrema };
}

// SVG A-command radii and rotation for an affine image of a circle.
export function ellipseParameters(m) {
  const [a, b, c, d] = m;
  const u = a * a + c * c;
  const v = b * b + d * d;
  const w = a * b + c * d;
  let angle = 0.5 * Math.atan2(2 * w, u - v);
  let major = Math.hypot(a * Math.cos(angle) + c * Math.sin(angle), b * Math.cos(angle) + d * Math.sin(angle));
  let minor = Math.hypot(-a * Math.sin(angle) + c * Math.cos(angle), -b * Math.sin(angle) + d * Math.cos(angle));

  if (minor > major) {
    angle += Math.PI / 2;
    [major, minor] = [minor, major];
  }

  return {
    rx: Math.max(major, 1e-12),
    ry: Math.max(minor, 1e-12),
    rotation: (angle * 180) / Math.PI,
  };
}
