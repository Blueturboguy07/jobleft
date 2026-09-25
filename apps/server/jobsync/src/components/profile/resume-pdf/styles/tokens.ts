import type { ResumeExportSettings } from "@/models/resumeExport.model";
import {
  styleTokens,
  type BaseStyleTokens,
} from "@/components/pdf-export/tokens";

// Certificate blocks sit at three quarters of an entry gap in both
// templates (6 against 8), so the ratio is identity at the default.
const CERT_SPACING_RATIO = 0.75;

export type StyleTokens = BaseStyleTokens & {
  sectionSpacing: number;
  entrySpacing: number;
  certSpacing: number;
};

export function resumeStyleTokens(
  settings: ResumeExportSettings,
): StyleTokens {
  return {
    ...styleTokens(settings),
    sectionSpacing: settings.sectionSpacing,
    entrySpacing: settings.entrySpacing,
    certSpacing: Math.round(settings.entrySpacing * CERT_SPACING_RATIO),
  };
}
