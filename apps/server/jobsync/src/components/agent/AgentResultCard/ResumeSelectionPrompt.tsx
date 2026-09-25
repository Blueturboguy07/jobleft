"use client";

import { AgentResumePicker } from "@/components/agent/AgentResumePicker";

export function ResumeSelectionPrompt({
  prompt,
  resumes,
  messageFor,
}: {
  prompt: string;
  resumes: { id: string; title: string }[];
  messageFor?: (title: string) => string;
}) {
  return (
    <div className="text-sm">
      <p>{prompt}</p>
      <AgentResumePicker resumes={resumes} messageFor={messageFor} />
    </div>
  );
}
