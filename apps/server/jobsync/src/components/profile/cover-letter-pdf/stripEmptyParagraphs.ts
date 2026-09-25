// html-to-pdf maps every <p> to a bodyText Text, including an empty one.
// With paragraphSpacing on bodyText.marginBottom, a blank line a user typed
// in Tiptap would print as an empty line plus a full paragraph gap. Dropping
// them here rather than in the shared converter keeps every exported resume
// byte-for-byte what it was.
export function stripEmptyParagraphs(html: string): string {
  return html.replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, "");
}
