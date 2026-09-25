import { parseCustomCredential } from "@/lib/ai/custom-endpoint";
import { PROVIDER_REGISTRY } from "@/lib/ai/provider-registry";
import { PROVIDER_FACTORIES } from "@/lib/ai/provider-registry.server";

describe("parseCustomCredential", () => {
  it("splits base URL and key on whitespace", () => {
    expect(parseCustomCredential("http://127.0.0.1:8080/v1 sk-abc")).toEqual({
      baseURL: "http://127.0.0.1:8080/v1",
      apiKey: "sk-abc",
    });
  });

  it("treats the key as optional and trims trailing slashes", () => {
    expect(parseCustomCredential("  http://localhost:1234/v1/  ")).toEqual({
      baseURL: "http://localhost:1234/v1",
      apiKey: undefined,
    });
  });
});

describe("custom provider", () => {
  it("is registered as a sensitive api-key entry with a models endpoint", () => {
    const entry = PROVIDER_REGISTRY.custom;
    expect(entry.credentialType).toBe("api-key");
    expect(entry.keyConfig.sensitive).toBe(true);
    expect(entry.modelsEndpoint).toBe("custom/models");
    expect(entry.parseModelsResponse!({ data: [{ id: "b" }, { id: "a" }] })).toEqual(["a", "b"]);
  });

  it("builds a Chat Completions model, not a Responses one", () => {
    const model = PROVIDER_FACTORIES.custom("http://127.0.0.1:8080/v1 sk-abc", "some-model");
    expect(model.modelId).toBe("some-model");
    expect(model.provider).toBe("openai.chat");
  });
});
