import { RotateCcw } from "lucide-react";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { Button } from "../design-system";
import {
  createNeutralToneRecipe,
  evaluateToneCurve,
  isNeutralToneCurve,
  sanitizeToneRecipe,
  type ImageToneRecipe,
} from "./imageTone";

const curvePoints: Array<{
  key: "curveBlack" | "curveShadows" | "curveMidtones" | "curveHighlights" | "curveWhite";
  label: string;
  input: number;
}> = [
  { key: "curveBlack", label: "Curve black", input: 0 },
  { key: "curveShadows", label: "Curve shadows", input: 25 },
  { key: "curveMidtones", label: "Curve midtones", input: 50 },
  { key: "curveHighlights", label: "Curve highlights", input: 75 },
  { key: "curveWhite", label: "Curve white", input: 100 },
];

function curvePolyline(recipe: ImageToneRecipe) {
  return Array.from({ length: 65 }, (_, index) => {
    const input = index / 64;
    return `${(input * 100).toFixed(2)},${(100 - evaluateToneCurve(input, recipe) * 100).toFixed(2)}`;
  }).join(" ");
}

export function ToneCurveControl({
  recipe,
  disabled,
  onChange,
}: {
  recipe: ImageToneRecipe;
  disabled: boolean;
  onChange: (recipe: ImageToneRecipe) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const values = curvePoints.map((point) => recipe[point.key]);
  const setPoint = (index: number, value: number) => {
    const minimum = index === 0 ? 0 : values[index - 1];
    const maximum = index === values.length - 1 ? 100 : values[index + 1];
    onChange(sanitizeToneRecipe({
      ...recipe,
      [curvePoints[index].key]: Math.min(maximum, Math.max(minimum, Math.round(value))),
    }));
  };
  const pointerPoint = (event: ReactPointerEvent<SVGCircleElement>, index: number) => {
    if (!svg.current || disabled) return;
    const bounds = svg.current.getBoundingClientRect();
    if (bounds.height <= 0) return;
    setPoint(index, 100 - (event.clientY - bounds.top) / bounds.height * 100);
  };
  const neutral = isNeutralToneCurve(recipe);
  return <fieldset className="quality-tone-curve">
    <legend>Tone curve</legend>
    <svg
      ref={svg}
      className="quality-tone-curve-chart"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {[25, 50, 75].map((position) => <g key={position}>
        <line x1={position} y1="0" x2={position} y2="100" />
        <line x1="0" y1={position} x2="100" y2={position} />
      </g>)}
      <line className="quality-tone-curve-neutral" x1="0" y1="100" x2="100" y2="0" />
      <polyline className="quality-tone-curve-line" points={curvePolyline(recipe)} />
      {curvePoints.map((point, index) => <circle
        key={point.key}
        data-testid={`tone-${point.key}`}
        cx={point.input}
        cy={100 - values[index]}
        r="2.5"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerPoint(event, index);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) pointerPoint(event, index);
        }}
      />)}
    </svg>
    <div className="quality-tone-curve-controls">
      {curvePoints.map((point, index) => <label className="quality-adjustment-control" key={point.key}>
        <span><strong>{point.label}</strong><output>{values[index]}%</output></span>
        <input
          aria-label={point.label}
          type="range"
          min={index === 0 ? 0 : values[index - 1]}
          max={index === values.length - 1 ? 100 : values[index + 1]}
          step="1"
          value={values[index]}
          disabled={disabled}
          onChange={(event) => setPoint(index, Number(event.target.value))}
        />
      </label>)}
    </div>
    <Button
      size="compact"
      disabled={disabled || neutral}
      onClick={() => {
        const defaults = createNeutralToneRecipe();
        onChange(sanitizeToneRecipe({
          ...recipe,
          curveBlack: defaults.curveBlack,
          curveShadows: defaults.curveShadows,
          curveMidtones: defaults.curveMidtones,
          curveHighlights: defaults.curveHighlights,
          curveWhite: defaults.curveWhite,
        }));
      }}
    ><RotateCcw aria-hidden="true" />Reset curve</Button>
    <p>Five fixed input anchors use smooth monotone interpolation. Points cannot cross, so the curve cannot invert tones.</p>
  </fieldset>;
}

