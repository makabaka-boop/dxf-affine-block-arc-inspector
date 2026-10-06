// Affine 2D transforms in the form:
// x' = a*x + c*y + e
// y' = b*x + d*y + f
// Coordinates use the drawing's Cartesian convention (Y up).

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

export function matrix(a, b, c, d, e, f) {
  return [a, b, c, d, e, f];
}

export function translation(x, y) {
  return [1, 0, 0, 1, x, y];
}

export function scale(sx, sy) {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotation(radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

export function applyPoint(m, p) {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}

export function multiply(left, right) {
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a0, b0, c0, d0, e0, f0] = right;
  return [
    a1 * a0 + c1 * b0,
    b1 * a0 + d1 * b0,
    a1 * c0 + c1 * d0,
    b1 * c0 + d1 * d0,
    a1 * e0 + c1 * f0 + e1,
    b1 * e0 + d1 * f0 + f1,
  ];
}

export function determinant(m) {
  return m[0] * m[3] - m[2] * m[1];
}

// DXF INSERT transform: insertion point * rotation * XY scale * block-base shift.
// DXF group 50 stores rotation in degrees. Negative scales are legal and mirror.
export function insertionTransform(insert, base, sx, sy) {
  const angle = (insert.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const a = cos * sx;
  const c = -sin * sy;
  const b = sin * sx;
  const d = cos * sy;

  return [
    a,
    b,
    c,
    d,
    insert.x - a * base.x - c * base.y,
    insert.y - b * base.x - d * base.y,
  ];
}
