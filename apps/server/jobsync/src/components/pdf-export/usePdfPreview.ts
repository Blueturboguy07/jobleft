"use client";
import { useEffect, useRef, useState } from "react";
import { settingsKey } from "@/models/pdfExport.model";

const PREVIEW_DEBOUNCE_MS = 250;

export type PreviewResult = { blob: Blob; filename: string };

// Owns the preview artifact: debounce, cache, and blob generation. Deliberately
// touches no canvas and creates no object URL — PdfPreviewPane owns rendering.
// `generate` is held in a ref so an inline arrow at the call site does not
// re-trigger the effect on every render.
export function usePdfPreview<T extends object>(
  generate: (settings: T) => Promise<PreviewResult>,
  settings: T,
  active: boolean,
) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const cacheRef = useRef(new Map<string, PreviewResult>());
  const hasRenderedRef = useRef(false);
  const runIdRef = useRef(0);

  // Read through refs so the effect can depend on primitives only.
  const generateRef = useRef(generate);
  generateRef.current = generate;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Sorted, so a rebuilt settings object hits the same cache entry as a
  // spread one and key order carries no meaning.
  const key = settingsKey(settings);

  useEffect(() => {
    if (!active) {
      // A document edited between openings must never show a stale preview.
      cacheRef.current.clear();
      hasRenderedRef.current = false;
      runIdRef.current += 1;
      setResult(null);
      setIsGenerating(false);
      setError(null);
      return;
    }

    const cached = cacheRef.current.get(key);
    if (cached) {
      runIdRef.current += 1;
      hasRenderedRef.current = true;
      setResult(cached);
      setIsGenerating(false);
      setError(null);
      return;
    }

    const runId = ++runIdRef.current;
    setIsGenerating(true);
    setError(null);

    const run = async () => {
      try {
        const generated = await generateRef.current(settingsRef.current);
        if (runIdRef.current !== runId) return;
        cacheRef.current.set(key, generated);
        setResult(generated);
        setError(null);
      } catch (e) {
        if (runIdRef.current !== runId) return;
        setResult(null);
        setError(e instanceof Error ? e : new Error("Preview failed"));
      } finally {
        if (runIdRef.current === runId) setIsGenerating(false);
      }
    };

    // Opening the dialog must not wait out a debounce nobody triggered.
    if (!hasRenderedRef.current) {
      hasRenderedRef.current = true;
      void run();
      return;
    }

    const timer = setTimeout(() => void run(), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, key]);

  return {
    blob: result?.blob ?? null,
    filename: result?.filename ?? null,
    isGenerating,
    error,
  };
}
