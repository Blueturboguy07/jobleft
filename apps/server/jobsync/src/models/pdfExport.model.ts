export type PdfFont = "helvetica" | "times" | "courier";

export const PDF_FONT_LABELS: Record<PdfFont, string> = {
  helvetica: "Helvetica",
  times: "Times",
  courier: "Courier",
};

// Every numeric field either document uses. A lookup table, never an
// iteration source — each document owns its own ordered field list.
export type NumericSetting =
  | "fontSize"
  | "lineHeight"
  | "marginVertical"
  | "marginHorizontal"
  | "sectionSpacing"
  | "entrySpacing"
  | "paragraphSpacing";

export type NumericSettingSpec = {
  label: string;
  min: number;
  max: number;
  step: number;
  // Places a value is rounded to on write; kills IEEE-754 step drift.
  decimals: number;
  unit: string;
};

// One table: the stepper rows, the summaries and the storage validators all
// read their bounds from here.
export const PDF_NUMERIC_SETTINGS: Record<NumericSetting, NumericSettingSpec> = {
  fontSize: { label: "Font size", min: 8, max: 16, step: 0.5, decimals: 1, unit: "pt" },
  lineHeight: { label: "Line height", min: 1, max: 2, step: 0.05, decimals: 2, unit: "" },
  marginVertical: { label: "Margin top/bottom", min: 18, max: 90, step: 2, decimals: 0, unit: "pt" },
  marginHorizontal: { label: "Margin left/right", min: 18, max: 90, step: 2, decimals: 0, unit: "pt" },
  sectionSpacing: { label: "Section spacing", min: 0, max: 32, step: 1, decimals: 0, unit: "pt" },
  entrySpacing: { label: "Entry spacing", min: 0, max: 32, step: 1, decimals: 0, unit: "pt" },
  paragraphSpacing: { label: "Paragraph spacing", min: 0, max: 24, step: 1, decimals: 0, unit: "pt" },
};

// The shape styleTokens consumes — the settings both documents share.
export interface BaseExportSettings {
  font: PdfFont;
  fontSize: number;
  lineHeight: number;
  marginVertical: number;
  marginHorizontal: number;
}

const roundTo = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

// Every write to a numeric setting goes through here — stepper buttons,
// typed input and the stored-value validators alike. `fallback` is the
// caller's own document default; the stepper passes none, since its value
// is finite by construction.
export function clampNumericField(
  field: NumericSetting,
  value: unknown,
  fallback?: number,
): number {
  const spec = PDF_NUMERIC_SETTINGS[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback ?? spec.min;
  }
  return roundTo(Math.min(spec.max, Math.max(spec.min, value)), spec.decimals);
}

// Reads the way the stepper input reads: a bare number, plus a unit when
// the field has one. `decimals` is for rounding, not for display.
export function formatSettingValue(
  field: NumericSetting,
  value: number,
): string {
  const spec = PDF_NUMERIC_SETTINGS[field];
  return spec.unit ? `${value} ${spec.unit}` : String(value);
}

// The one way a settings object becomes a string — the preview cache key and
// every "is this still the default?" check. Sorting the keys means the order
// a literal was written in carries no meaning, so a rebuilt object compares
// equal to a spread one. Settings are flat; the array replacer would drop the
// keys of a nested object.
export function settingsKey(settings: object): string {
  return JSON.stringify(settings, Object.keys(settings).sort());
}
