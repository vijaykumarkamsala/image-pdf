import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  cropAspectRatio,
  sanitizeCropRect,
  sanitizePerspectiveQuad,
  type ImageCropAspect,
  type ImageCropRect,
  type ImagePerspectiveQuad,
} from "./imageGeometry";

interface CropSelectionEditorProps {
  sourceUrl: string;
  filename: string;
  sourceWidth: number;
  sourceHeight: number;
  crop: ImageCropRect;
  perspective: ImagePerspectiveQuad | null;
  aspect: ImageCropAspect;
  disabled?: boolean;
  onChange: (crop: ImageCropRect) => void;
  onPerspectiveChange: (perspective: ImagePerspectiveQuad) => void;
}

type DragMode = "move" | "nw" | "ne" | "se" | "sw";
type PerspectiveCorner = keyof ImagePerspectiveQuad;

interface FrameGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}

function frameGeometry(frameWidth: number, frameHeight: number, sourceWidth: number, sourceHeight: number): FrameGeometry {
  const availableWidth = Math.max(1, frameWidth - 48);
  const availableHeight = Math.max(1, frameHeight - 48);
  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { left: (frameWidth - width) / 2, top: (frameHeight - height) / 2, width, height, scale };
}

function useElementSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

export function CropSelectionEditor({
  sourceUrl,
  filename,
  sourceWidth,
  sourceHeight,
  crop,
  perspective,
  aspect,
  disabled = false,
  onChange,
  onPerspectiveChange,
}: CropSelectionEditorProps) {
  const { ref, size } = useElementSize();
  const drag = useRef<{
    pointerId: number;
    mode: DragMode;
    startX: number;
    startY: number;
    crop: ImageCropRect;
  } | null>(null);
  const perspectiveDrag = useRef<{ pointerId: number; corner: PerspectiveCorner } | null>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const frame = frameGeometry(size.width, size.height, sourceWidth, sourceHeight);
  const safeCrop = sanitizeCropRect(crop, sourceWidth, sourceHeight, Math.min(32, sourceWidth, sourceHeight));
  const safePerspective = perspective ? sanitizePerspectiveQuad(perspective) : null;
  const selectionStyle = {
    left: `${frame.left + safeCrop.x * frame.scale}px`,
    top: `${frame.top + safeCrop.y * frame.scale}px`,
    width: `${safeCrop.width * frame.scale}px`,
    height: `${safeCrop.height * frame.scale}px`,
    backgroundImage: `url("${sourceUrl}")`,
    backgroundPosition: `${-safeCrop.x * frame.scale}px ${-safeCrop.y * frame.scale}px`,
    backgroundSize: `${frame.width}px ${frame.height}px`,
  };

  const begin = (event: ReactPointerEvent<HTMLElement>, mode: DragMode) => {
    if (disabled || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      crop: safeCrop,
    };
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId || disabled) return;
    const deltaX = (event.clientX - active.startX) / frame.scale;
    const deltaY = (event.clientY - active.startY) / frame.scale;
    const minimum = Math.min(32, sourceWidth, sourceHeight);
    if (active.mode === "move") {
      onChange(sanitizeCropRect({
        ...active.crop,
        x: active.crop.x + deltaX,
        y: active.crop.y + deltaY,
      }, sourceWidth, sourceHeight, minimum));
      return;
    }

    const west = active.mode.includes("w");
    const north = active.mode.includes("n");
    const fixedX = west ? active.crop.x + active.crop.width : active.crop.x;
    const fixedY = north ? active.crop.y + active.crop.height : active.crop.y;
    let movingX = west ? active.crop.x + deltaX : active.crop.x + active.crop.width + deltaX;
    let movingY = north ? active.crop.y + deltaY : active.crop.y + active.crop.height + deltaY;
    movingX = Math.min(sourceWidth, Math.max(0, movingX));
    movingY = Math.min(sourceHeight, Math.max(0, movingY));

    const ratio = cropAspectRatio(aspect, sourceWidth, sourceHeight);
    if (ratio !== null) {
      let width = Math.max(minimum, Math.abs(movingX - fixedX));
      let height = Math.max(minimum, Math.abs(movingY - fixedY));
      if (width / height > ratio) width = height * ratio;
      else height = width / ratio;
      const maximumWidth = west ? fixedX : sourceWidth - fixedX;
      const maximumHeight = north ? fixedY : sourceHeight - fixedY;
      const fit = Math.min(1, maximumWidth / width, maximumHeight / height);
      width *= fit;
      height *= fit;
      movingX = fixedX + (west ? -width : width);
      movingY = fixedY + (north ? -height : height);
    }
    onChange(sanitizeCropRect({
      x: Math.min(fixedX, movingX),
      y: Math.min(fixedY, movingY),
      width: Math.abs(movingX - fixedX),
      height: Math.abs(movingY - fixedY),
    }, sourceWidth, sourceHeight, minimum));
  };

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  const updatePerspective = (corner: PerspectiveCorner, clientX: number, clientY: number) => {
    if (!safePerspective || !selectionRef.current) return;
    const bounds = selectionRef.current.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    onPerspectiveChange(sanitizePerspectiveQuad({
      ...safePerspective,
      [corner]: {
        x: (clientX - bounds.left) / bounds.width,
        y: (clientY - bounds.top) / bounds.height,
      },
    }));
  };

  const beginPerspective = (event: ReactPointerEvent<HTMLButtonElement>, corner: PerspectiveCorner) => {
    if (disabled || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    perspectiveDrag.current = { pointerId: event.pointerId, corner };
  };

  const movePerspective = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = perspectiveDrag.current;
    if (!active || active.pointerId !== event.pointerId || disabled) return;
    event.stopPropagation();
    updatePerspective(active.corner, event.clientX, event.clientY);
  };

  const endPerspective = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (perspectiveDrag.current?.pointerId === event.pointerId) perspectiveDrag.current = null;
  };

  return <div className="quality-crop-stage" ref={ref} data-testid="crop-selection-editor">
    <img
      src={sourceUrl}
      alt={`Crop source ${filename}`}
      draggable={false}
      style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
    />
    <div className="quality-crop-shade" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }} aria-hidden="true" />
    <div
      ref={selectionRef}
      className="quality-crop-selection"
      style={selectionStyle}
      role="group"
      aria-label={`Crop selection: ${safeCrop.width} by ${safeCrop.height} pixels`}
      onPointerDown={(event) => begin(event, "move")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span className="quality-crop-grid" aria-hidden="true" />
      {!safePerspective && (["nw", "ne", "se", "sw"] as const).map((handle) => <button
        key={handle}
        type="button"
        className={`quality-crop-handle quality-crop-handle-${handle}`}
        aria-label={`Resize crop from ${handle.toUpperCase()} corner`}
        disabled={disabled}
        onPointerDown={(event) => begin(event, handle)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />)}
      {safePerspective && <>
        <svg className="quality-perspective-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={[
            safePerspective.topLeft,
            safePerspective.topRight,
            safePerspective.bottomRight,
            safePerspective.bottomLeft,
          ].map((point) => `${point.x * 100},${point.y * 100}`).join(" ")} />
        </svg>
        {(Object.keys(safePerspective) as PerspectiveCorner[]).map((corner) => {
          const point = safePerspective[corner];
          const name = corner.replace(/([A-Z])/g, " $1").toLowerCase();
          return <button
            key={corner}
            type="button"
            className="quality-perspective-handle"
            aria-label={`Perspective ${name} point`}
            disabled={disabled}
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            onPointerDown={(event) => beginPerspective(event, corner)}
            onPointerMove={movePerspective}
            onPointerUp={endPerspective}
            onPointerCancel={endPerspective}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.05 : 0.01;
              const delta = event.key === "ArrowLeft" ? { x: -step, y: 0 }
                : event.key === "ArrowRight" ? { x: step, y: 0 }
                  : event.key === "ArrowUp" ? { x: 0, y: -step }
                    : event.key === "ArrowDown" ? { x: 0, y: step }
                      : null;
              if (!delta) return;
              event.preventDefault();
              onPerspectiveChange(sanitizePerspectiveQuad({
                ...safePerspective,
                [corner]: { x: point.x + delta.x, y: point.y + delta.y },
              }));
            }}
          />;
        })}
      </>}
    </div>
  </div>;
}
