import "server-only";

// Ollama answers 400 '"<model>" does not support thinking' when a request sets
// think:true for a model that has no thinking capability (qwen2.5, llama3.x,
// smollm2 ...). Ask the server what the model can do, once per model.
const cache = new Map<string, boolean>();

export async function ollamaSupportsThinking(
  baseUrl: string,
  model: string,
): Promise<boolean> {
  const key = `${baseUrl}|${model}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/show`, {
      method: "POST",
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false; // not cached: try again next turn
    const info = (await res.json()) as { capabilities?: string[] };
    const supported = info.capabilities?.includes("thinking") ?? false;
    cache.set(key, supported);
    return supported;
  } catch {
    return false;
  }
}
