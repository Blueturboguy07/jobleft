"use client";

import { Button } from "@/components/ui/button";
import {
  DisclosureGroup,
  SelectRow,
  StepperRow,
} from "@/components/pdf-export/settings-rows";
import {
  formatSettingValue,
  PDF_FONT_LABELS,
} from "@/models/pdfExport.model";
import type {
  CoverLetterExportSettings,
  CoverLetterNumericSetting,
} from "@/models/coverLetterExport.model";

type CoverLetterSettingsPanelProps = {
  settings: CoverLetterExportSettings;
  onChange: (settings: CoverLetterExportSettings) => void;
  onReset?: () => void;
  isDefault?: boolean;
  /** False once the lookup has resolved and found no contact info. */
  hasLetterhead: boolean;
};

const ID_PREFIX = "cover-letter-export";

export function CoverLetterSettingsPanel({
  settings,
  onChange,
  onReset,
  isDefault,
  hasLetterhead,
}: CoverLetterSettingsPanelProps) {
  const setNumber = (field: CoverLetterNumericSetting) => (value: number) =>
    onChange({ ...settings, [field]: value });

  const typographySummary = [
    PDF_FONT_LABELS[settings.font],
    formatSettingValue("fontSize", settings.fontSize),
    `${formatSettingValue("lineHeight", settings.lineHeight)} line`,
  ].join(" • ");

  const layoutSummary = [
    `${settings.marginVertical} × ${settings.marginHorizontal} pt margins`,
    `${settings.paragraphSpacing} pt paragraphs`,
  ].join(" • ");

  return (
    <div className="flex flex-col gap-4">
      {/* No Template row: a cover letter has exactly one style. */}
      <DisclosureGroup title="Typography" summary={typographySummary}>
        <SelectRow
          id={`${ID_PREFIX}-font`}
          label="Font"
          value={settings.font}
          labels={PDF_FONT_LABELS}
          onSelect={(font) => onChange({ ...settings, font })}
        />
        <StepperRow
          idPrefix={ID_PREFIX}
          field="fontSize"
          value={settings.fontSize}
          onCommit={setNumber("fontSize")}
        />
        <StepperRow
          idPrefix={ID_PREFIX}
          field="lineHeight"
          value={settings.lineHeight}
          onCommit={setNumber("lineHeight")}
        />
      </DisclosureGroup>

      <DisclosureGroup title="Layout" summary={layoutSummary}>
        <StepperRow
          idPrefix={ID_PREFIX}
          field="marginVertical"
          value={settings.marginVertical}
          onCommit={setNumber("marginVertical")}
        />
        <StepperRow
          idPrefix={ID_PREFIX}
          field="marginHorizontal"
          value={settings.marginHorizontal}
          onCommit={setNumber("marginHorizontal")}
        />
        <StepperRow
          idPrefix={ID_PREFIX}
          field="paragraphSpacing"
          value={settings.paragraphSpacing}
          onCommit={setNumber("paragraphSpacing")}
        />
      </DisclosureGroup>

      {/* A page with no name on it otherwise reads as a bug, and the fix is
          not discoverable from this dialog. */}
      {!hasLetterhead && (
        <p className="text-xs text-muted-foreground">
          No letterhead — set a default resume with contact info to add your
          name and contact line.
        </p>
      )}

      {onReset && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={isDefault}
          >
            Reset to defaults
          </Button>
        </div>
      )}
    </div>
  );
}
