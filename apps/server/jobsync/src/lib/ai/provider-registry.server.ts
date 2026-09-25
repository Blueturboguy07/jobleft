import "server-only";

import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider-v2";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { APP_CONSTANTS } from "@/lib/constants";
import { parseCustomCredential } from "@/lib/ai/custom-endpoint";

export const PROVIDER_FACTORIES: Record<
  string,
  (credential: string, modelName: string) => any
> = {
  openai: (apiKey, model) => createOpenAI({ apiKey })(model),
  openrouter: (apiKey, model) =>
    createOpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" })(model),
  // .chat(): openai(model) targets the Responses API in @ai-sdk/openai v3,
  // which llama.cpp / MLX / LM Studio do not serve. Chat Completions they do.
  custom: (credential, model) => {
    const { baseURL, apiKey } = parseCustomCredential(credential);
    return createOpenAI({ baseURL, apiKey: apiKey ?? "not-needed" }).chat(model);
  },
  deepseek: (apiKey, model) => createDeepSeek({ apiKey })(model),
  ollama: (baseURL, model) =>
    createOllama({ baseURL: baseURL + "/api" })(model),
  gemini: (apiKey, model) => createGoogleGenerativeAI({ apiKey })(model),
};

export const PROVIDER_VERIFIERS: Record<
  string,
  (key: string) => Promise<{ success: boolean; error?: string }>
> = {
  openai: async (key) => {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok)
      return {
        success: false,
        error:
          res.status === 401
            ? "Invalid API key"
            : `OpenAI returned ${res.status}`,
      };
    return { success: true };
  },

  openrouter: async (key) => {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok)
      return {
        success: false,
        error:
          res.status === 401
            ? "Invalid API key"
            : `OpenRouter returned ${res.status}`,
      };
    return { success: true };
  },

  custom: async (credential) => {
    const { baseURL, apiKey } = parseCustomCredential(credential);
    if (!/^https?:\/\//.test(baseURL))
      return { success: false, error: `Invalid base URL: ${baseURL}` };
    try {
      const res = await fetch(`${baseURL}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      // 404: the server is up but has no model list. Still usable.
      if (!res.ok && res.status !== 404)
        return {
          success: false,
          error:
            res.status === 401 || res.status === 403
              ? "Invalid API key"
              : `Endpoint returned ${res.status}`,
        };
      return { success: true };
    } catch {
      return { success: false, error: `Cannot connect to ${baseURL}` };
    }
  },

  deepseek: async (key) => {
    const res = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok)
      return {
        success: false,
        error:
          res.status === 401
            ? "Invalid API key"
            : `DeepSeek returned ${res.status}`,
      };
    return { success: true };
  },

  ollama: async (key) => {
    const baseUrl = key.replace(/\/+$/, "");
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(APP_CONSTANTS.AI_OLLAMA_LIST_TIMEOUT_MS),
      });
      if (!res.ok)
        return {
          success: false,
          error: `Cannot connect to Ollama at ${baseUrl}`,
        };
      return { success: true };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return {
          success: false,
          error: `Ollama at ${baseUrl} did not respond in time. Please make sure Ollama is running.`,
        };
      }
      if (
        error instanceof TypeError &&
        /failed to parse url/i.test(error.message)
      ) {
        return {
          success: false,
          error: `Invalid Ollama URL: ${baseUrl}`,
        };
      }
      return {
        success: false,
        error: `Cannot connect to Ollama at ${baseUrl}. Please make sure Ollama is running.`,
      };
    }
  },

  gemini: async (key) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
    );
    if (!res.ok)
      return {
        success: false,
        error:
          res.status === 400 || res.status === 403
            ? "Invalid API key"
            : `Gemini returned ${res.status}`,
      };
    return { success: true };
  },
};
