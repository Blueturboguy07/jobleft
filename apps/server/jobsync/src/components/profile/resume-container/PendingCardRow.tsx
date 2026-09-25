"use client";
import { useTransition } from "react";
import { Check, Loader, X } from "lucide-react";
import type { ImportCardPayload } from "@/actions/resumeImport.actions";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import type { PendingCard } from "./pendingCards";

function cardSectionLabel(type: ImportCardPayload["type"]): string {
  const map: Record<string, string> = {
    contactInfo: "Contact Info",
    summary: "Summary",
    experience: "Experience",
    education: "Education",
    certification: "Certification",
    skills: "Skills",
  };
  return map[type] ?? type;
}

function DetailRow({ label, value }: { label: string; value?: unknown }) {
  // Streaming partials can momentarily emit a non-string (e.g. {}) for a field
  // before it resolves — never hand a non-primitive to React.
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (value === "") return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <span className="text-foreground break-words min-w-0">{value}</span>
    </div>
  );
}

function PendingCardDetail({ card }: { card: ImportCardPayload }) {
  if (card.type === "contactInfo") {
    const d = card.data;
    const name = `${d.firstName ?? ""} ${d.lastName ?? ""}`.trim();
    return (
      <div className="space-y-1 mt-1">
        {name && <DetailRow label="Name" value={name} />}
        <DetailRow label="Headline" value={d.headline} />
        <DetailRow label="Email" value={d.email} />
        <DetailRow label="Phone" value={d.phone} />
        <DetailRow label="Address" value={d.address} />
      </div>
    );
  }

  if (card.type === "summary") {
    return (
      <p className="text-xs text-foreground mt-1 whitespace-pre-wrap">
        {card.data}
      </p>
    );
  }

  if (card.type === "experience") {
    const d = card.data;
    const dates = [d.startDate, d.endDate].filter(Boolean).join(" – ");
    return (
      <div className="space-y-1 mt-1">
        <DetailRow label="Title" value={d.jobTitle} />
        <DetailRow label="Company" value={d.company} />
        <DetailRow label="Location" value={d.location} />
        {dates && <DetailRow label="Dates" value={dates} />}
        {typeof d.description === "string" && d.description && (
          <p className="text-xs text-foreground mt-1 whitespace-pre-wrap pl-[5.5rem]">
            {d.description}
          </p>
        )}
      </div>
    );
  }

  if (card.type === "education") {
    const d = card.data;
    const dates = [d.startDate, d.endDate].filter(Boolean).join(" – ");
    return (
      <div className="space-y-1 mt-1">
        <DetailRow label="Institution" value={d.institution} />
        <DetailRow label="Degree" value={d.degree} />
        <DetailRow label="Field" value={d.fieldOfStudy} />
        <DetailRow label="Location" value={d.location} />
        {dates && <DetailRow label="Dates" value={dates} />}
        {typeof d.description === "string" && d.description && (
          <p className="text-xs text-foreground mt-1 whitespace-pre-wrap pl-[5.5rem]">
            {d.description}
          </p>
        )}
      </div>
    );
  }

  if (card.type === "certification") {
    const d = card.data;
    return (
      <div className="space-y-1 mt-1">
        <DetailRow label="Title" value={d.title} />
        <DetailRow label="Issuer" value={d.organization} />
        <DetailRow label="Issued" value={d.issueDate} />
        <DetailRow label="Expires" value={d.expirationDate} />
        <DetailRow label="URL" value={d.credentialUrl} />
      </div>
    );
  }

  if (card.type === "skills") {
    const categories = card.data.categories ?? [];
    return (
      <div className="space-y-2 mt-1">
        {categories.map((cat, i) => {
          const skills = (cat.skills ?? []).filter(
            (s): s is string => typeof s === "string" && !!s.trim(),
          );
          if (skills.length === 0) return null;
          return (
            <div key={i} className="space-y-1">
              {typeof cat.label === "string" && cat.label && (
                <span className="text-xs font-medium text-muted-foreground">
                  {cat.label}
                </span>
              )}
              <div className="flex flex-wrap gap-1">
                {skills.map((skill, j) => (
                  <Badge key={j} variant="secondary" className="text-xs">
                    {skill}
                  </Badge>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return null;
}

// Individual pending card row
export function PendingCardRow({
  pending,
  onAccept,
  onDiscard,
  locked,
}: {
  pending: PendingCard;
  onAccept: (id: string) => void;
  onDiscard: (id: string) => void;
  locked?: boolean;
}) {
  const [isSaving, startSaving] = useTransition();

  return (
    <div className="border border-dashed rounded-md px-4 py-3 bg-muted/30">
      <div className="flex items-start justify-between gap-4">
        <Badge variant="outline" className="text-xs shrink-0">
          {cardSectionLabel(pending.card.type)}
        </Badge>
        <div className="flex items-center gap-1 shrink-0 ml-auto">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={isSaving || locked}
            onClick={() =>
              startSaving(async () => {
                await onAccept(pending.id);
              })
            }
          >
            {isSaving ? (
              <Loader className="h-3 w-3 spinner" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            <span className="ml-1">Accept</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            disabled={isSaving || locked}
            onClick={() => onDiscard(pending.id)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <PendingCardDetail card={pending.card} />
    </div>
  );
}
