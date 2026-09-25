import type { ContactInfo } from "@/models/profile.model";

export type ContactPart = { text: string; href?: string };

// The one-line "email · phone · address · url1 · url2" assembly, shared by
// SimpleTemplate's header and the cover letter's letterhead. Professional's
// header is a different two-column layout and deliberately does not use this.
export function buildContactParts(
  contactInfo: ContactInfo | null | undefined,
): ContactPart[] {
  if (!contactInfo) return [];
  const stripScheme = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "");

  return [
    contactInfo.email ? { text: contactInfo.email } : null,
    contactInfo.phone ? { text: contactInfo.phone } : null,
    contactInfo.address ? { text: contactInfo.address } : null,
    contactInfo.url1
      ? { text: stripScheme(contactInfo.url1), href: contactInfo.url1 }
      : null,
    contactInfo.url2
      ? { text: stripScheme(contactInfo.url2), href: contactInfo.url2 }
      : null,
  ].filter((p): p is ContactPart => p !== null);
}
