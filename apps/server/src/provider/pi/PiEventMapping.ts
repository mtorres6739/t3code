/**
 * Pure helpers that map Pi tool names / message shapes into T3 canonical types.
 *
 * @module provider/pi/PiEventMapping
 */

import type { CanonicalItemType, ToolLifecycleItemType } from "@t3tools/contracts";

import { isRecord } from "./PiJsonl.ts";

export function canonicalItemTypeFromPiToolName(
  toolName: string | undefined,
): ToolLifecycleItemType {
  const name = (toolName ?? "").toLowerCase();
  if (name === "bash" || name === "shell" || name === "run" || name === "exec") {
    return "command_execution";
  }
  if (
    name === "edit" ||
    name === "write" ||
    name === "apply_patch" ||
    name === "str_replace" ||
    name === "multiedit"
  ) {
    return "file_change";
  }
  if (name === "read" || name === "read_file" || name === "cat") {
    return "file_change";
  }
  if (name === "web_search" || name === "search" || name === "fetch" || name === "websearch") {
    return "web_search";
  }
  if (name.startsWith("mcp_") || name.includes("mcp")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

export function toolTitleFromPiArgs(
  toolName: string | undefined,
  args: unknown,
): string | undefined {
  if (!isRecord(args)) {
    return toolName?.trim() || undefined;
  }
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command) {
    return command.length > 120 ? `${command.slice(0, 117)}...` : command;
  }
  const path =
    (typeof args.path === "string" && args.path.trim()) ||
    (typeof args.file_path === "string" && args.file_path.trim()) ||
    (typeof args.filePath === "string" && args.filePath.trim()) ||
    "";
  if (path) {
    return path;
  }
  return toolName?.trim() || undefined;
}

export function textFromPiContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("");
}

export function summarizePiToolResult(result: unknown): string | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (isRecord(result)) {
    if (typeof result.output === "string" && result.output.trim()) {
      return result.output;
    }
    const fromContent = textFromPiContent(result.content);
    if (fromContent.trim()) {
      return fromContent;
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function isAssistantMessageRole(message: unknown): boolean {
  return isRecord(message) && message.role === "assistant";
}

export function assistantMessageHasVisibleText(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const content = message.content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) return false;
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (entry.type === "text" && typeof entry.text === "string" && entry.text.length > 0) {
      return true;
    }
    if (
      entry.type === "thinking" &&
      typeof entry.thinking === "string" &&
      entry.thinking.length > 0
    ) {
      return true;
    }
  }
  return false;
}

export function assistantItemTypeForStream(
  streamKind: "assistant_text" | "reasoning_text",
): CanonicalItemType {
  return streamKind === "reasoning_text" ? "reasoning" : "assistant_message";
}
