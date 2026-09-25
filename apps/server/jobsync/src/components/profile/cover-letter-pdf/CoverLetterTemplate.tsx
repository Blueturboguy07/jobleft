import React from "react";
import { Document, Link, Page, Text, View } from "@react-pdf/renderer";
import type { ContactInfo } from "@/models/profile.model";
import { buildContactParts } from "../pdf-contact-parts";
import type { LetterStyles } from "./styles/letter.styles";

type Props = {
  title: string;
  contactInfo: ContactInfo | null;
  dateLabel: string;
  bodyNodes: React.ReactElement[];
  styles: LetterStyles;
};

// The body already carries its own salutation and its "Sincerely," close —
// that comes from the generation prompt and is stored in `content`. This
// template never injects a salutation, a recipient block or a signature.
export function CoverLetterDocument({
  title,
  contactInfo,
  dateLabel,
  bodyNodes,
  styles,
}: Props) {
  const contactParts = buildContactParts(contactInfo);

  return (
    <Document
      author={`${contactInfo?.firstName ?? ""} ${contactInfo?.lastName ?? ""}`.trim()}
      creator="jobsync.ca"
      producer="react-pdf"
      title={title}
    >
      <Page size="A4" style={styles.page} wrap>
        {contactInfo && (
          <View>
            <Text style={styles.name}>
              {contactInfo.firstName} {contactInfo.lastName}
            </Text>
            {contactInfo.headline ? (
              <Text style={styles.headline}>{contactInfo.headline}</Text>
            ) : null}
            {contactParts.length > 0 ? (
              <View style={styles.contactRow}>
                {contactParts.map((part, i) => (
                  <Text key={i} style={styles.contactLine}>
                    {i > 0 ? " · " : ""}
                    {part.href ? (
                      <Link src={part.href} style={styles.link}>
                        {part.text}
                      </Link>
                    ) : (
                      part.text
                    )}
                  </Text>
                ))}
              </View>
            ) : null}
            <View style={styles.rule} />
          </View>
        )}

        <Text style={styles.date}>{dateLabel}</Text>

        {bodyNodes}
      </Page>
    </Document>
  );
}
