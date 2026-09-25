// Custom OpenAI-compatible endpoint (llama.cpp, MLX, LM Studio, vLLM, a gateway).
// The registry holds one credential string per provider, so both parts travel
// in it: "<base URL> [API key]", separated by whitespace. The key is optional
// because local servers usually need none.
export function parseCustomCredential(credential: string): {
  baseURL: string;
  apiKey?: string;
} {
  const [baseURL = "", ...rest] = credential.trim().split(/\s+/);
  const apiKey = rest.join(" ");
  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey: apiKey || undefined,
  };
}
