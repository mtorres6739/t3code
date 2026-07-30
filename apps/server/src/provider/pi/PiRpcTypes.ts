/**
 * Minimal Pi RPC protocol types used by the T3 adapter boundary.
 *
 * @module provider/pi/PiRpcTypes
 */

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface PiModel {
  readonly id: string;
  readonly provider: string;
  readonly name?: string | undefined;
  readonly reasoning?: boolean | undefined;
  readonly contextWindow?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly api?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly input?: ReadonlyArray<string> | undefined;
  readonly thinkingLevelMap?: Readonly<Record<string, string>> | undefined;
}

/** Command reported by Pi RPC `get_commands` (extension, prompt, or skill). */
export interface PiCommand {
  readonly name: string;
  readonly description?: string | undefined;
  readonly argumentHint?: string | undefined;
  readonly source?: string | undefined;
}

export interface PiRpcResponse {
  readonly type: "response";
  readonly id?: string | undefined;
  readonly command: string;
  readonly success: boolean;
  readonly error?: string | undefined;
  readonly data?: unknown;
}

export interface PiRpcCommand {
  readonly type: string;
  readonly id?: string | undefined;
  readonly [key: string]: unknown;
}

export type PiRpcOutbound =
  | PiRpcCommand
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly value?: string | undefined;
      readonly confirmed?: boolean | undefined;
      readonly cancelled?: boolean | undefined;
    };

export function isPiThinkingLevel(value: string): value is PiThinkingLevel {
  return (PI_THINKING_LEVELS as ReadonlyArray<string>).includes(value);
}

export function piModelSlug(model: Pick<PiModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function parsePiModelSlug(
  slug: string | null | undefined,
): { provider: string; modelId: string } | undefined {
  const trimmed = slug?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}
