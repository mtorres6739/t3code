// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  discoverPiModels,
  parsePiCommandsFromResponse,
  parsePiModelsFromResponse,
  parsePiThinkingLevelsFromResponse,
  spawnPiRpcClient,
} from "./PiRpcClient.ts";

async function writeFakePiRpc(scriptBody: string): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-rpc-"));
  const path = NodePath.join(dir, "fake-pi.sh");
  await NodeFSP.writeFile(path, scriptBody, "utf8");
  await NodeFSP.chmod(path, 0o755);
  return path;
}

/** Fake Pi that reads one JSON object per stdin chunk (matches Effect stream writes). */
const basicRpcScript = `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const id = msg.id;
    const respond = (command, success, data, error) => {
      process.stdout.write(JSON.stringify({
        type: "response", id, command, success,
        ...(data !== undefined ? { data } : {}),
        ...(error ? { error } : {}),
      }) + "\\n");
    };
    switch (msg.type) {
      case "get_available_models":
        respond("get_available_models", true, {
          models: [
            { id: "claude-sonnet", provider: "anthropic", name: "Sonnet", reasoning: true },
            { id: "gpt-5", provider: "openai", name: "GPT-5", reasoning: false },
          ],
        });
        break;
      case "get_available_thinking_levels":
        respond("get_available_thinking_levels", true, { levels: ["off", "low", "medium", "high"] });
        break;
      case "get_state":
        respond("get_state", true, {
          model: { id: "claude-sonnet", provider: "anthropic" },
          thinkingLevel: "medium",
        });
        break;
      case "set_model":
        if (!msg.provider || !msg.modelId) {
          respond("set_model", false, undefined, "missing model");
          break;
        }
        respond("set_model", true, { id: msg.modelId, provider: msg.provider, name: msg.modelId });
        break;
      case "set_thinking_level":
        respond("set_thinking_level", true);
        break;
      case "get_commands":
        respond("get_commands", true, {
          commands: [
            { name: "review", description: "Review changes", source: "prompt" },
            { name: "skill:test", description: "Test skill", source: "skill" },
            { name: "llama", description: "Manage models", source: "extension", argumentHint: "[model]" },
          ],
        });
        break;
      case "prompt":
        respond("prompt", true);
        process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hello" },
        }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        break;
      case "abort":
        respond("abort", true);
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        break;
      case "extension_ui_response":
        break;
      case "fail":
        respond("fail", false, undefined, "boom");
        break;
      default:
        respond(msg.type || "unknown", false, undefined, "unknown command");
    }
  }
});
`;

describe("parsePiCommandsFromResponse", () => {
  it("parses valid extension, prompt, and skill commands", () => {
    const commands = parsePiCommandsFromResponse({
      commands: [
        { name: "llama", description: "Manage models", source: "extension" },
        { name: "review", description: "Review changes", source: "prompt", argumentHint: "[path]" },
        { name: "skill:ios-debugger-agent", description: "iOS debug", source: "skill" },
      ],
    });
    assert.equal(commands.length, 3);
    assert.deepEqual(commands[0], {
      name: "llama",
      description: "Manage models",
      source: "extension",
    });
    assert.deepEqual(commands[1], {
      name: "review",
      description: "Review changes",
      argumentHint: "[path]",
      source: "prompt",
    });
    assert.equal(commands[2]?.name, "skill:ios-debugger-agent");
  });

  it("returns empty for malformed payloads and drops empty names", () => {
    assert.deepEqual(parsePiCommandsFromResponse(undefined), []);
    assert.deepEqual(parsePiCommandsFromResponse(null), []);
    assert.deepEqual(parsePiCommandsFromResponse({}), []);
    assert.deepEqual(parsePiCommandsFromResponse({ commands: "nope" }), []);
    assert.deepEqual(
      parsePiCommandsFromResponse({
        commands: [{ name: "" }, { name: "   " }, null, 42, { description: "no name" }],
      }),
      [],
    );
  });

  it("dedupes command names case-insensitively and fills missing description/hint", () => {
    const commands = parsePiCommandsFromResponse({
      commands: [
        { name: "Review", source: "prompt" },
        { name: "review", description: "Review changes", argumentHint: "[path]", source: "prompt" },
        { name: "REVIEW", description: "ignored", argumentHint: "ignored" },
      ],
    });
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0], {
      name: "Review",
      description: "Review changes",
      argumentHint: "[path]",
      source: "prompt",
    });
  });

  it("accepts hint aliases on command objects", () => {
    assert.deepEqual(
      parsePiCommandsFromResponse({
        commands: [{ name: "a", hint: "from-hint" }],
      })[0],
      { name: "a", argumentHint: "from-hint" },
    );
    assert.deepEqual(
      parsePiCommandsFromResponse({
        commands: [{ name: "b", input: { hint: "from-input" } }],
      })[0],
      { name: "b", argumentHint: "from-input" },
    );
  });
});

it.layer(NodeServices.layer)("PiRpcClient", (it) => {
  it.effect("correlates requests, streams events, and handles command errors", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => writeFakePiRpc(basicRpcScript));
      const client = yield* spawnPiRpcClient({ binaryPath, commandTimeout: "3 seconds" });

      const modelsResponse = yield* client.send({ type: "get_available_models" });
      const models = parsePiModelsFromResponse(modelsResponse.data);
      assert.equal(models.length, 2);
      assert.equal(models[0]?.provider, "anthropic");

      const thinkingResponse = yield* client.send({ type: "get_available_thinking_levels" });
      assert.deepEqual(parsePiThinkingLevelsFromResponse(thinkingResponse.data), [
        "off",
        "low",
        "medium",
        "high",
      ]);

      const settled = yield* Deferred.make<ReadonlyArray<unknown>>();
      const collected: unknown[] = [];
      const eventFiber = yield* client.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            collected.push(event);
            if (
              event &&
              typeof event === "object" &&
              "type" in event &&
              (event as { type: string }).type === "agent_settled"
            ) {
              yield* Deferred.succeed(settled, [...collected]).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkChild,
      );

      yield* client.send({ type: "prompt", message: "hi" });
      const events = yield* Deferred.await(settled);
      const eventTypes = events.map((event) =>
        event && typeof event === "object" && "type" in event
          ? (event as { type: string }).type
          : undefined,
      );
      assert.deepEqual(eventTypes, ["agent_start", "message_update", "agent_settled"]);

      const failed = yield* client.send({ type: "fail" }).pipe(Effect.result);
      assert.equal(failed._tag, "Failure");

      yield* client.write({
        type: "extension_ui_response",
        id: "ui-1",
        cancelled: true,
      });

      yield* Fiber.interrupt(eventFiber).pipe(Effect.ignore);
      yield* client.dispose();
    }).pipe(Effect.scoped),
  );

  it.effect("fails pending requests and cleans up when the child exits", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        writeFakePiRpc(`#!/usr/bin/env node
// Exit immediately after a short delay so the client is already waiting.
setTimeout(() => process.exit(0), 50);
process.stdin.resume();
`),
      );
      const client = yield* spawnPiRpcClient({
        binaryPath,
        commandTimeout: "2 seconds",
      });

      // Effect tests use a TestClock, so wait on the real process clock here.
      yield* Effect.promise(() => NodeTimersPromises.setTimeout(150));
      const result = yield* client.send({ type: "get_available_models" }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      yield* client.dispose();
    }).pipe(Effect.scoped),
  );

  it.effect("accepts CRLF-framed stdout from the child", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        writeFakePiRpc(`#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    process.stdout.write(JSON.stringify({
      type: "response",
      id: msg.id,
      command: msg.type,
      success: true,
      data: { models: [{ id: "m", provider: "p" }] },
    }) + "\\r\\n");
  }
});
`),
      );
      const client = yield* spawnPiRpcClient({ binaryPath, commandTimeout: "3 seconds" });
      const response = yield* client.send({ type: "get_available_models" });
      assert.equal(parsePiModelsFromResponse(response.data).length, 1);
      yield* client.dispose();
    }).pipe(Effect.scoped),
  );

  it.effect("discoverPiModels returns commands from get_commands", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => writeFakePiRpc(basicRpcScript));
      const discovery = yield* discoverPiModels({
        binaryPath,
        commandTimeout: "3 seconds",
      });
      assert.equal(discovery.models.length, 2);
      assert.equal(discovery.commands.length, 3);
      assert.equal(discovery.commands[0]?.name, "review");
      assert.equal(discovery.commands[1]?.name, "skill:test");
      assert.equal(discovery.commands[2]?.argumentHint, "[model]");
    }).pipe(Effect.scoped),
  );

  it.effect("discoverPiModels keeps models when get_commands fails", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        writeFakePiRpc(`#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const id = msg.id;
    const respond = (command, success, data, error) => {
      process.stdout.write(JSON.stringify({
        type: "response", id, command, success,
        ...(data !== undefined ? { data } : {}),
        ...(error ? { error } : {}),
      }) + "\\n");
    };
    switch (msg.type) {
      case "get_available_models":
        respond("get_available_models", true, {
          models: [{ id: "m", provider: "p", name: "M", reasoning: false }],
        });
        break;
      case "get_state":
        respond("get_state", true, { model: { id: "m", provider: "p" } });
        break;
      case "get_available_thinking_levels":
        respond("get_available_thinking_levels", true, { levels: ["off"] });
        break;
      case "get_commands":
        respond("get_commands", false, undefined, "unknown command");
        break;
      default:
        respond(msg.type || "unknown", false, undefined, "unknown command");
    }
  }
});
`),
      );
      const discovery = yield* discoverPiModels({
        binaryPath,
        commandTimeout: "3 seconds",
      });
      assert.equal(discovery.models.length, 1);
      assert.equal(discovery.models[0]?.id, "m");
      assert.deepEqual(discovery.commands, []);
    }).pipe(Effect.scoped),
  );
});
