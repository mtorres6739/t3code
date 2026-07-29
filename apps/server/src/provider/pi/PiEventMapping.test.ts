import { describe, expect, it } from "vite-plus/test";

import {
  assistantMessageHasVisibleText,
  canonicalItemTypeFromPiToolName,
  summarizePiToolResult,
  toolTitleFromPiArgs,
} from "./PiEventMapping.ts";
import { parsePiModelSlug, piModelSlug } from "./PiRpcTypes.ts";

describe("Pi event mapping helpers", () => {
  it("maps tool names to lifecycle item types", () => {
    expect(canonicalItemTypeFromPiToolName("bash")).toBe("command_execution");
    expect(canonicalItemTypeFromPiToolName("edit")).toBe("file_change");
    expect(canonicalItemTypeFromPiToolName("read")).toBe("file_change");
    expect(canonicalItemTypeFromPiToolName("web_search")).toBe("web_search");
    expect(canonicalItemTypeFromPiToolName("mcp_fetch")).toBe("mcp_tool_call");
    expect(canonicalItemTypeFromPiToolName("unknown_tool")).toBe("dynamic_tool_call");
  });

  it("prefers command/path titles from tool args", () => {
    expect(toolTitleFromPiArgs("bash", { command: "ls -la" })).toBe("ls -la");
    expect(toolTitleFromPiArgs("read", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolTitleFromPiArgs("edit", {})).toBe("edit");
  });

  it("summarizes tool results without inventing content", () => {
    expect(summarizePiToolResult(undefined)).toBeUndefined();
    expect(summarizePiToolResult("  ")).toBeUndefined();
    expect(summarizePiToolResult("ok")).toBe("ok");
    expect(summarizePiToolResult({ output: "done" })).toBe("done");
  });

  it("detects visible assistant text and ignores empty tool-only shapes", () => {
    expect(
      assistantMessageHasVisibleText({
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    ).toBe(true);
    expect(
      assistantMessageHasVisibleText({
        role: "assistant",
        content: [{ type: "toolCall", name: "bash" }],
      }),
    ).toBe(false);
  });

  it("round-trips model slugs", () => {
    expect(piModelSlug({ provider: "anthropic", id: "claude-sonnet" })).toBe(
      "anthropic/claude-sonnet",
    );
    expect(parsePiModelSlug("anthropic/claude-sonnet")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet",
    });
    expect(parsePiModelSlug("broken")).toBeUndefined();
  });
});
