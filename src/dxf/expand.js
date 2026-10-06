import { arcFromBulge, arcBounds } from '../geometry/arc.js';
import { applyPoint, determinant, insertionTransform, IDENTITY, multiply } from '../geometry/transform.js';

export const MAX_INSERT_DEPTH = 4;
export const MAX_EXPANDED_ENTITIES = 60;

export class ExpansionError extends Error {
  constructor(message, path = []) {
    super(message);
    this.name = 'ExpansionError';
    this.path = path;
  }
}

function pathKey(path) {
  return path.map((entry) => entry.oid).join('/');
}

function emptyBounds() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function unionBounds(...boxes) {
  const result = emptyBounds();
  for (const box of boxes) {
    if (!box) continue;
    result.minX = Math.min(result.minX, box.minX);
    result.minY = Math.min(result.minY, box.minY);
    result.maxX = Math.max(result.maxX, box.maxX);
    result.maxY = Math.max(result.maxY, box.maxY);
  }
  return Number.isFinite(result.minX) ? result : null;
}

function segmentBounds(start, end, arc, m) {
  if (arc) return arcBounds(arc, m);
  const points = [start, end];
  let minX = points[0].x;
  let maxX = minX;
  let minY = points[0].y;
  let maxY = minY;
  for (const p of points.slice(1)) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function buildLeaf(source, path, parentMatrix, counter) {
  const id = `leaf:${[...path.map((entry) => entry.oid), source.oid].join('/')}`;

  if (source.kind === 'line') {
    const start = applyPoint(parentMatrix, source.start);
    const end = applyPoint(parentMatrix, source.end);
    const bbox = segmentBounds(start, end, null, parentMatrix);
    return {
      id,
      kind: 'leaf',
      entityKind: 'line',
      sourceOid: source.oid,
      path: path.map((entry) => ({ ...entry })),
      start,
      end,
      bbox,
    };
  }

  const points = source.vertices.map((p) => applyPoint(parentMatrix, p));
  const segmentCount = source.closed ? source.vertices.length : source.vertices.length - 1;
  const segments = [];

  for (let i = 0; i < segmentCount; i++) {
    const next = (i + 1) % source.vertices.length;
    const start = points[i];
    const end = points[next];
    const bulge = source.bulges[i] || 0;
    const arc = bulge === 0 ? null : arcFromBulge(source.vertices[i], source.vertices[next], bulge);
    const bbox = arc ? arcBounds(arc, parentMatrix) : segmentBounds(start, end);
    segments.push({
      id: `${id}/segment-${i}`,
      index: i,
      start,
      end,
      bulge,
      arc,
      matrix: parentMatrix,
      orientation: arc ? Math.sign(determinant(parentMatrix)) * arc.direction : 0,
      bbox,
      closing: source.closed && i === segmentCount - 1,
    });
  }

  return {
    id,
    kind: 'leaf',
    entityKind: 'polyline',
    sourceOid: source.oid,
    path: path.map((entry) => ({ ...entry })),
    closed: source.closed,
    vertices: points,
    segments,
    bbox: unionBounds(...segments.map((segment) => segment.bbox)),
  };
}

function scaleFor(insert, key, overrides) {
  const changed = overrides.get(key);
  const sx = changed && changed.sx !== undefined ? changed.sx : insert.sx;
  const sy = changed && changed.sy !== undefined ? changed.sy : insert.sy;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx === 0 || sy === 0) {
    throw new ExpansionError(`Zero or non-finite scale on INSERT "${insert.name}" is rejected`);
  }
  return { sx, sy };
}

function expandRecursive(source, parentMatrix, path, activeNames, blocks, overrides, counter) {
  const block = blocks.get(source.name);
  if (!block) {
    throw new ExpansionError(`Unknown block "${source.name}" referenced by INSERT`, path.map((entry) => ({ ...entry })));
  }
  if (path.length + 1 > MAX_INSERT_DEPTH) {
    throw new ExpansionError(`Block nesting exceeds the ${MAX_INSERT_DEPTH}-level limit`, path.map((entry) => ({ ...entry })));
  }
  if (activeNames.has(source.name)) {
    throw new ExpansionError(
      `Circular block reference through "${source.name}" is rejected`,
      path.map((entry) => ({ ...entry })),
    );
  }

  const entryPath = [
    ...path,
    {
      oid: source.oid,
      name: source.name,
      depth: path.length + 1,
      blockBase: { ...block.base },
      rotationDeg: source.rotationDeg,
      localPoint: { x: source.x, y: source.y },
      worldPoint: { x: source.x, y: source.y },
    },
  ];
  const key = pathKey(entryPath);
  const { sx, sy } = scaleFor(source, key, overrides);
  entryPath[entryPath.length - 1].sx = sx;
  entryPath[entryPath.length - 1].sy = sy;
  entryPath[entryPath.length - 1].overrideKey = key;

  const local = insertionTransform(source, block.base, sx, sy);
  const matrix = path.length === 0 ? local : multiply(parentMatrix, local);
  entryPath[entryPath.length - 1].worldPoint = applyPoint(matrix, block.base);

  activeNames.add(source.name);
  const children = [];
  for (const child of block.entities) {
    if (counter.leafCount >= MAX_EXPANDED_ENTITIES) {
      throw new ExpansionError(`Expanded entity count exceeds the ${MAX_EXPANDED_ENTITIES}-entity limit`, entryPath);
    }
    if (child.kind === 'insert') {
      children.push(expandRecursive(child, matrix, entryPath, activeNames, blocks, overrides, counter));
    } else {
      children.push(buildLeaf(child, entryPath, matrix, counter));
      counter.leafCount += 1;
      if (counter.leafCount > MAX_EXPANDED_ENTITIES) {
        throw new ExpansionError(`Expanded entity count exceeds the ${MAX_EXPANDED_ENTITIES}-entity limit`, entryPath);
      }
    }
  }
  activeNames.delete(source.name);

  return {
    id: `insert:${key}`,
    kind: 'insert',
    sourceOid: source.oid,
    name: source.name,
    path: entryPath,
    overrideKey: key,
    sx,
    sy,
    rotationDeg: source.rotationDeg,
    insertionPoint: applyPoint(matrix, block.base),
    blockBase: { ...block.base },
    matrix,
    children,
    bbox: unionBounds(...children.map((child) => child.bbox)),
  };
}

// Rebuild every real occurrence from immutable parser objects. `overrides` is keyed
// by complete INSERT path, so editing one occurrence never changes the shared BLOCK.
export function expandDrawing(drawing, overrides = new Map()) {
  const counter = { leafCount: 0 };
  const nodes = [];

  for (const source of drawing.entities) {
    if (source.kind === 'insert') {
      nodes.push(expandRecursive(source, IDENTITY, [], new Set(), drawing.blocks, overrides, counter));
    } else {
      if (counter.leafCount >= MAX_EXPANDED_ENTITIES) {
        throw new ExpansionError(`Expanded entity count exceeds the ${MAX_EXPANDED_ENTITIES}-entity limit`, []);
      }
      nodes.push(buildLeaf(source, [], IDENTITY, counter));
      counter.leafCount += 1;
    }
  }

  const insertNodes = [];
  const leafNodes = [];
  const segments = [];
  const walk = (node) => {
    if (node.kind === 'insert') {
      insertNodes.push(node);
      node.children.forEach(walk);
    } else {
      leafNodes.push(node);
      if (node.entityKind === 'polyline') segments.push(...node.segments);
    }
  };
  nodes.forEach(walk);

  return {
    nodes,
    insertNodes,
    leafNodes,
    segments,
    bbox: unionBounds(...nodes.map((node) => node.bbox)),
    leafCount: counter.leafCount,
  };
}

export function allSegments(expansion) {
  const result = [];
  for (const leaf of expansion.leafNodes) {
    if (leaf.entityKind === 'line') {
      result.push({
        id: `${leaf.id}/line`,
        leaf,
        index: 0,
        start: leaf.start,
        end: leaf.end,
        bulge: 0,
        arc: null,
        matrix: IDENTITY,
        orientation: 0,
        bbox: leaf.bbox,
        closing: false,
      });
    } else {
      for (const segment of leaf.segments) result.push({ ...segment, leaf });
    }
  }
  return result;
}
