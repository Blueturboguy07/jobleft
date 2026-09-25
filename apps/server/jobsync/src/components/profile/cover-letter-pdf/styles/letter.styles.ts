import { StyleSheet } from "@react-pdf/renderer";
import { HtmlStyleSet } from "@/components/pdf-export/types";
import { styleTokens } from "@/components/pdf-export/tokens";
import type { CoverLetterExportSettings } from "@/models/coverLetterExport.model";

export function buildLetterStyles(settings: CoverLetterExportSettings) {
  const t = styleTokens(settings);

  const styles = StyleSheet.create({
    page: {
      fontFamily: t.font.regular,
      fontSize: t.fontSize,
      paddingTop: t.marginVertical,
      paddingBottom: t.marginVertical,
      paddingHorizontal: t.marginHorizontal,
      color: "#000000",
      lineHeight: t.lineHeight,
    },
    name: {
      fontSize: t.pt(16),
      fontFamily: t.font.bold,
      marginBottom: 4,
    },
    headline: {
      fontSize: t.fontSize,
      marginBottom: 2,
    },
    contactRow: { flexDirection: "row", flexWrap: "wrap" },
    contactLine: {
      fontSize: t.pt(10),
      color: "#444444",
      marginBottom: 2,
    },
    link: { color: "#000000", textDecoration: "none" },
    rule: {
      borderBottomWidth: 0.5,
      borderBottomColor: "#000000",
      marginTop: 8,
      marginBottom: 16,
    },
    date: {
      fontSize: t.fontSize,
      marginBottom: 16,
    },
    bold: { fontFamily: t.font.bold },
    italic: { fontFamily: t.font.italic },
    boldItalic: { fontFamily: t.font.boldItalic },
    // paragraphSpacing reaches exactly this one property. Every other gap
    // in the letterhead is a plain literal. Read off `settings`, not `t` —
    // the shared tokens expose only the five universal values, exactly as
    // resumeStyleTokens adds the resume's two rather than pushing them down.
    bodyText: { fontSize: t.fontSize, marginBottom: settings.paragraphSpacing },
    h2text: {
      fontFamily: t.font.bold,
      fontSize: t.pt(13),
      marginBottom: 3,
      marginTop: 4,
    },
    listRow: { flexDirection: "row", marginBottom: 1 },
    bullet: { width: t.pt(14), fontSize: t.fontSize },
    listText: { flex: 1, fontSize: t.fontSize },
  });

  const htmlStyles: HtmlStyleSet = {
    bodyText: styles.bodyText,
    bold: styles.bold,
    italic: styles.italic,
    boldItalic: styles.boldItalic,
    h2text: styles.h2text,
    listRow: styles.listRow,
    bullet: styles.bullet,
    listText: styles.listText,
    bulletChar: "•",
  };

  return { styles, htmlStyles };
}

export type LetterStyles = ReturnType<typeof buildLetterStyles>["styles"];
