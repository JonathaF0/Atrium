import { BadGatewayException, Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

const DEFAULT_TIMEOUT_MS = 45_000;
const logger = new Logger("AiClient");

export type AiProvider = "anthropic" | "openai";

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string | null;
  timeoutMs: number;
}

/** The env side of the feature flag. Null when AI assist is off or not fully configured. */
export function readAiConfig(config: ConfigService): AiConfig | null {
  if (config.get<string>("AI_ASSIST_ENABLED") !== "true") return null;
  const provider = (config.get<string>("AI_PROVIDER") ?? "anthropic").trim().toLowerCase();
  const apiKey = config.get<string>("AI_API_KEY")?.trim() ?? "";
  const model = config.get<string>("AI_MODEL")?.trim() ?? "";
  if (provider !== "anthropic" && provider !== "openai") return null;
  // A self-hosted OpenAI-compatible server may not need a key; a model is always required.
  if (!model || (provider === "anthropic" && !apiKey)) return null;
  const timeout = Number.parseInt(config.get<string>("AI_TIMEOUT_MS") ?? "", 10);
  return {
    provider,
    apiKey,
    model,
    baseUrl: config.get<string>("AI_BASE_URL")?.trim().replace(/\/+$/, "") || null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 120_000) : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * One completion call to the configured provider (Anthropic, or any
 * OpenAI-compatible server). Logs status codes only, never prompt or reply text.
 */
export async function completeText(
  cfg: AiConfig,
  prompt: { system: string; user: string; maxTokens?: number },
): Promise<string> {
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  const maxTokens: number = prompt.maxTokens ?? 4096;
  let res: Response;
  try {
    if (cfg.provider === "anthropic") {
      res = await fetch(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
        }),
      });
    } else {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      res = await fetch(`${cfg.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
      });
    }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    logger.warn(`AI provider request failed (${timedOut ? "timeout" : "network error"})`);
    throw new BadGatewayException(timedOut ? "The AI provider took too long to answer" : "Could not reach the AI provider");
  }
  if (!res.ok) {
    logger.warn(`AI provider responded with HTTP ${res.status}`);
    throw new BadGatewayException("The AI provider rejected the request");
  }
  const body = (await res.json().catch(() => null)) as unknown;
  const text = extractText(cfg.provider, body);
  if (!text) throw new BadGatewayException("The AI provider returned an empty answer");
  return text;
}

/** The reply text from an Anthropic Messages or OpenAI chat completion response body. */
export function extractText(provider: AiProvider, body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  if (provider === "anthropic") {
    const content = (body as { content?: Array<{ type?: string; text?: string }> }).content;
    if (!Array.isArray(content)) return null;
    const text = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
    return text || null;
  }
  const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = Array.isArray(choices) ? choices[0]?.message?.content : null;
  return typeof content === "string" && content ? content : null;
}
