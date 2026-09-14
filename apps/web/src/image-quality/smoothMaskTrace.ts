interface Point {
  x: number;
  y: number;
}

interface Edge {
  end: number;
  start: number;
  used: boolean;
}

const pointKey = (x: number, y: number, stride: number) => y * stride + x;

const pointFromKey = (key: number, stride: number): Point => ({
  x: key % stride,
  y: Math.floor(key / stride),
});

const direction = (start: number, end: number, stride: number) => {
  const first = pointFromKey(start, stride);
  const second = pointFromKey(end, stride);
  if (second.x > first.x) return 0;
  if (second.y > first.y) return 1;
  if (second.x < first.x) return 2;
  return 3;
};

const distanceToSegmentSquared = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  const position = Math.max(0, Math.min(1, (
    (point.x - start.x) * dx + (point.y - start.y) * dy
  ) / (dx * dx + dy * dy)));
  const projectedX = start.x + position * dx;
  const projectedY = start.y + position * dy;
  return (point.x - projectedX) ** 2 + (point.y - projectedY) ** 2;
};

function simplifyOpen(points: Point[], toleranceSquared: number): Point[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const segments: Array<readonly [number, number]> = [[0, points.length - 1]];
  while (segments.length > 0) {
    const [start, end] = segments.pop()!;
    let furthestIndex = -1;
    let furthestDistance = toleranceSquared;
    for (let index = start + 1; index < end; index += 1) {
      const distance = distanceToSegmentSquared(points[index], points[start], points[end]);
      if (distance <= furthestDistance) continue;
      furthestDistance = distance;
      furthestIndex = index;
    }
    if (furthestIndex < 0) continue;
    keep[furthestIndex] = 1;
    segments.push([start, furthestIndex], [furthestIndex, end]);
  }
  return points.filter((_point, index) => keep[index] === 1);
}

function cyclicSlice(points: Point[], start: number, end: number): Point[] {
  const output: Point[] = [];
  let index = start;
  while (true) {
    output.push(points[index]);
    if (index === end) return output;
    index = (index + 1) % points.length;
  }
}

function simplifyClosed(points: Point[], tolerance: number): Point[] {
  const collinear = points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    return (point.x - previous.x) * (next.y - point.y)
      !== (point.y - previous.y) * (next.x - point.x);
  });
  if (collinear.length <= 4) return collinear;
  let minimumX = 0;
  let maximumX = 0;
  let minimumY = 0;
  let maximumY = 0;
  for (let index = 1; index < collinear.length; index += 1) {
    if (collinear[index].x < collinear[minimumX].x) minimumX = index;
    if (collinear[index].x > collinear[maximumX].x) maximumX = index;
    if (collinear[index].y < collinear[minimumY].y) minimumY = index;
    if (collinear[index].y > collinear[maximumY].y) maximumY = index;
  }
  const horizontalSpan = collinear[maximumX].x - collinear[minimumX].x;
  const verticalSpan = collinear[maximumY].y - collinear[minimumY].y;
  const firstAnchor = horizontalSpan >= verticalSpan ? minimumX : minimumY;
  const secondAnchor = horizontalSpan >= verticalSpan ? maximumX : maximumY;
  const toleranceSquared = tolerance * tolerance;
  const first = simplifyOpen(cyclicSlice(collinear, firstAnchor, secondAnchor), toleranceSquared);
  const second = simplifyOpen(cyclicSlice(collinear, secondAnchor, firstAnchor), toleranceSquared);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

const format = (value: number) => Number(value.toFixed(3)).toString();

function contourPerimeter(points: Point[]): number {
  let perimeter = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    perimeter += Math.hypot(next.x - points[index].x, next.y - points[index].y);
  }
  return perimeter;
}

function pointAtArcDistance(
  points: Point[],
  startIndex: number,
  step: -1 | 1,
  targetDistance: number,
): Point {
  let currentIndex = startIndex;
  let current = points[currentIndex];
  let remaining = targetDistance;
  for (let traversed = 0; traversed < points.length; traversed += 1) {
    const nextIndex = (currentIndex + step + points.length) % points.length;
    const next = points[nextIndex];
    const segmentLength = Math.hypot(next.x - current.x, next.y - current.y);
    if (segmentLength >= remaining && segmentLength > 0) {
      const position = remaining / segmentLength;
      return {
        x: current.x + (next.x - current.x) * position,
        y: current.y + (next.y - current.y) * position,
      };
    }
    remaining -= segmentLength;
    currentIndex = nextIndex;
    current = next;
  }
  return current;
}

function ellipsePathIfApplicable(points: Point[]): string | null {
  if (points.length < 8) return null;
  let minimumX = points[0].x;
  let maximumX = points[0].x;
  let minimumY = points[0].y;
  let maximumY = points[0].y;
  for (const point of points) {
    minimumX = Math.min(minimumX, point.x);
    maximumX = Math.max(maximumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumY = Math.max(maximumY, point.y);
  }
  const radiusX = (maximumX - minimumX) / 2;
  const radiusY = (maximumY - minimumY) / 2;
  if (radiusX < 2 || radiusY < 2) return null;
  // Pixel masks describe samples at integer coordinates while their traced
  // edges lie on integer boundaries. With an odd raster span the bounding-box
  // midpoint is therefore half a pixel past the sampled primitive centre.
  const centerX = Math.floor((minimumX + maximumX) / 2);
  const centerY = Math.floor((minimumY + maximumY) / 2);
  let maximumRadialError = 0;
  for (const point of points) {
    const radialDistance = Math.hypot(
      (point.x - centerX) / radiusX,
      (point.y - centerY) / radiusY,
    );
    maximumRadialError = Math.max(maximumRadialError, Math.abs(radialDistance - 1));
  }
  // Only recover a true ellipse when every boundary sample supports it. This
  // makes circles exact without forcing rounded rectangles or organic curves
  // into an incorrect primitive.
  if (maximumRadialError > 0.105) return null;
  const kappa = 0.552284749831;
  const horizontalHandle = radiusX * kappa;
  const verticalHandle = radiusY * kappa;
  return `M${format(centerX + radiusX)} ${format(centerY)}`
    + `C${format(centerX + radiusX)} ${format(centerY + verticalHandle)} `
    + `${format(centerX + horizontalHandle)} ${format(centerY + radiusY)} `
    + `${format(centerX)} ${format(centerY + radiusY)}`
    + `C${format(centerX - horizontalHandle)} ${format(centerY + radiusY)} `
    + `${format(centerX - radiusX)} ${format(centerY + verticalHandle)} `
    + `${format(centerX - radiusX)} ${format(centerY)}`
    + `C${format(centerX - radiusX)} ${format(centerY - verticalHandle)} `
    + `${format(centerX - horizontalHandle)} ${format(centerY - radiusY)} `
    + `${format(centerX)} ${format(centerY - radiusY)}`
    + `C${format(centerX + horizontalHandle)} ${format(centerY - radiusY)} `
    + `${format(centerX + radiusX)} ${format(centerY - verticalHandle)} `
    + `${format(centerX + radiusX)} ${format(centerY)}Z`;
}

function pathForContour(points: Point[]): string {
  if (points.length < 3) return "";
  const ellipsePath = ellipsePathIfApplicable(points);
  if (ellipsePath) return ellipsePath;
  const lookDistance = Math.max(4, Math.min(16, contourPerimeter(points) / 300));
  const corner = points.map((point, index) => {
    const previous = pointAtArcDistance(points, index, -1, lookDistance);
    const next = pointAtArcDistance(points, index, 1, lookDistance);
    const incomingX = point.x - previous.x;
    const incomingY = point.y - previous.y;
    const outgoingX = next.x - point.x;
    const outgoingY = next.y - point.y;
    const denominator = Math.hypot(incomingX, incomingY) * Math.hypot(outgoingX, outgoingY);
    if (denominator === 0) return true;
    const cosine = Math.max(-1, Math.min(1, (incomingX * outgoingX + incomingY * outgoingY) / denominator));
    return Math.acos(cosine) * 180 / Math.PI >= 55;
  });
  const midpoint = (first: Point, second: Point): Point => ({
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  });
  const start = corner[0] ? points[0] : midpoint(points[points.length - 1], points[0]);
  let current = start;
  let path = `M${format(start.x)} ${format(start.y)}`;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const endIndex = (index + 1) % points.length;
    const next = points[endIndex];
    if (corner[index]) {
      if (current.x !== point.x || current.y !== point.y) {
        path += `L${format(point.x)} ${format(point.y)}`;
      }
      const end = corner[endIndex] ? next : midpoint(point, next);
      if (end.x !== point.x || end.y !== point.y) path += `L${format(end.x)} ${format(end.y)}`;
      current = end;
      continue;
    }
    const end = corner[endIndex] ? next : midpoint(point, next);
    path += `Q${format(point.x)} ${format(point.y)} ${format(end.x)} ${format(end.y)}`;
    current = end;
  }
  return `${path}Z`;
}

export function traceSmoothMaskSvg(mask: Uint8Array, width: number, height: number): string {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Mask dimensions are invalid.");
  }
  if (mask.length !== width * height) throw new Error("Mask pixel data is incomplete.");
  const vertexStride = width + 1;
  const edges: Edge[] = [];
  const outgoing = new Map<number, number[]>();
  const addEdge = (startX: number, startY: number, endX: number, endY: number) => {
    const edge: Edge = {
      start: pointKey(startX, startY, vertexStride),
      end: pointKey(endX, endY, vertexStride),
      used: false,
    };
    const index = edges.push(edge) - 1;
    const candidates = outgoing.get(edge.start);
    if (candidates) candidates.push(index);
    else outgoing.set(edge.start, [index]);
  };
  const isForeground = (x: number, y: number) => (
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] >= 128
  );
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isForeground(x, y)) continue;
      if (!isForeground(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!isForeground(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!isForeground(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!isForeground(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }
  const contours: Point[][] = [];
  for (let startIndex = 0; startIndex < edges.length; startIndex += 1) {
    if (edges[startIndex].used) continue;
    const contour: Point[] = [];
    const firstVertex = edges[startIndex].start;
    let edgeIndex = startIndex;
    while (!edges[edgeIndex].used) {
      const edge = edges[edgeIndex];
      edge.used = true;
      contour.push(pointFromKey(edge.start, vertexStride));
      if (edge.end === firstVertex) break;
      const candidates = (outgoing.get(edge.end) ?? []).filter((candidate) => !edges[candidate].used);
      if (candidates.length === 0) break;
      const incomingDirection = direction(edge.start, edge.end, vertexStride);
      const turnPriority = [1, 0, 3, 2];
      candidates.sort((first, second) => (
        turnPriority.indexOf((direction(edges[first].start, edges[first].end, vertexStride) - incomingDirection + 4) % 4)
        - turnPriority.indexOf((direction(edges[second].start, edges[second].end, vertexStride) - incomingDirection + 4) % 4)
      ));
      edgeIndex = candidates[0];
    }
    if (contour.length >= 4) contours.push(contour);
  }
  // A tolerance just above a one-pixel diagonal staircase removes raster
  // wobble while remaining below the distance that would erase real detail.
  const tolerance = 0.75 + Math.min(0.75, Math.max(width, height) / 1_024 * 0.75);
  const path = contours
    .map((contour) => pathForContour(simplifyClosed(contour, tolerance)))
    .filter(Boolean)
    .join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${path}" fill="black" fill-rule="evenodd"/></svg>`;
}
