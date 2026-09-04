import Anthropic from "@anthropic-ai/sdk";

/** Proveedor Anthropic. El formato interno del enjambre es el de la Messages API, así que no hay conversión. */
export function createAnthropicProvider({ apiKey, defaults }) {
  const client = new Anthropic({ apiKey });
  return {
    name: "anthropic",
    defaults,
    async complete({ model, system, messages, tools, maxTokens, effort }) {
      const request = { model, max_tokens: maxTokens, system, messages, thinking: { type: "adaptive" }, output_config: { effort } };
      if (tools?.length) request.tools = tools;
      const response = await client.messages.stream(request).finalMessage();
      return { content: response.content, stop_reason: response.stop_reason, usage: response.usage, model: response.model };
    }
  };
}
