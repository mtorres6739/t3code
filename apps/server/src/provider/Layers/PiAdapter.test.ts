// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const piAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const FAKE_PI_RPC = `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
let model = { id: "claude-sonnet", provider: "anthropic", name: "Sonnet" };
let thinking = "medium";
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
        respond("get_available_models", true, { models: [model] });
        break;
      case "get_available_thinking_levels":
        respond("get_available_thinking_levels", true, { levels: ["off", "low", "medium", "high"] });
        break;
      case "get_state":
        respond("get_state", true, { model, thinkingLevel: thinking });
        break;
      case "set_model":
        model = { id: msg.modelId, provider: msg.provider, name: msg.modelId };
        respond("set_model", true, model);
        break;
      case "set_thinking_level":
        thinking = msg.level;
        respond("set_thinking_level", true);
        break;
      case "prompt": {
        respond("prompt", true);
        if (msg.message === "tools-only") {
          process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName: "bash",
            args: { command: "echo hi" },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "call-1",
            toolName: "bash",
            result: { output: "hi" },
            isError: false,
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          break;
        }
        if (msg.message === "ask-ui") {
          process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "extension_ui_request",
            id: "ui-select-1",
            method: "select",
            title: "Pick one",
            options: ["A", "B"],
          }) + "\\n");
          break;
        }
        if (msg.message === "editor-ui") {
          process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "extension_ui_request",
            id: "ui-editor-1",
            method: "editor",
            title: "Edit",
            prefill: "x",
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          break;
        }
        if (msg.message === "unknown-event") {
          process.stdout.write(JSON.stringify({ type: "future_pi_event_v99", payload: 1 }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "ok" },
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          break;
        }
        process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hello " },
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "world" },
        }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        break;
      }
      case "abort":
        respond("abort", true);
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        break;
      case "extension_ui_response":
        if (msg.id === "ui-select-1") {
          process.stdout.write(JSON.stringify({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "chose " + (msg.value || "") },
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        }
        break;
      default:
        respond(msg.type || "unknown", false, undefined, "unknown");
    }
  }
});
`;

async function writeFakePi(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-adapter-"));
  const path = NodePath.join(dir, "fake-pi");
  await NodeFSP.writeFile(path, FAKE_PI_RPC, "utf8");
  await NodeFSP.chmod(path, 0o755);
  return path;
}

function subscribeEvents(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  threadId: ThreadId,
  onEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
) {
  return Stream.runForEach(stream, (event) => {
    if (String(event.threadId) !== String(threadId)) {
      return Effect.void;
    }
    return onEvent(event);
  }).pipe(Effect.forkChild);
}

it.layer(piAdapterTestLayer)("PiAdapter", (it) => {
  it.effect("maps a text turn with lazy assistant items and single settlement", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => writeFakePi());
      const adapter = yield* makePiAdapter(decodePiSettings({ binaryPath }));
      const threadId = ThreadId.make("thread-pi-1");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* subscribeEvents(adapter.streamEvents, threadId, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      );

      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: NodeOS.tmpdir(),
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-sonnet",
          options: [{ id: "thinking", value: "high" }],
        },
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "hello",
      });
      assert.ok(turn.turnId);
      yield* Deferred.await(turnCompleted);

      const types = runtimeEvents.map((event) => event.type);
      assert.ok(types.includes("session.started"));
      assert.ok(types.includes("turn.started"));
      assert.ok(types.includes("item.started"));
      assert.ok(types.includes("content.delta"));
      assert.ok(types.includes("turn.completed"));
      assert.equal(types.filter((type) => type === "turn.started").length, 1);
      assert.equal(types.filter((type) => type === "turn.completed").length, 1);

      const deltas = runtimeEvents.filter((event) => event.type === "content.delta");
      assert.ok(deltas.some((event) => event.payload.streamKind === "reasoning_text"));
      assert.ok(deltas.some((event) => event.payload.streamKind === "assistant_text"));

      yield* Fiber.interrupt(eventsFiber).pipe(Effect.ignore);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("tool-only turns do not create empty assistant bubbles", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => writeFakePi());
      const adapter = yield* makePiAdapter(decodePiSettings({ binaryPath }));
      const threadId = ThreadId.make("thread-pi-tools");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* subscribeEvents(adapter.streamEvents, threadId, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      );

      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "tools-only" });
      yield* Deferred.await(turnCompleted);

      const assistantStarts = runtimeEvents.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantStarts.length, 0);
      const toolStarts = runtimeEvents.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "command_execution",
      );
      assert.equal(toolStarts.length, 1);

      yield* Fiber.interrupt(eventsFiber).pipe(Effect.ignore);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupts an in-flight turn via abort", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => writeFakePi());
      const adapter = yield* makePiAdapter(decodePiSettings({ binaryPath }));
      const threadId = ThreadId.make("thread-pi-abort");
      const settled = yield* Deferred.make<ProviderRuntimeEvent>();
      const eventsFiber = yield* subscribeEvents(adapter.streamEvents, threadId, (event) =>
        event.type === "turn.completed"
          ? Deferred.succeed(settled, event).pipe(Effect.ignore)
          : Effect.void,
      );

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "ask-ui" });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      const event = yield* Deferred.await(settled);
      assert.equal(event.type, "turn.completed");
      if (event.type === "turn.completed") {
        assert.equal(event.payload.state, "interrupted");
      }

      yield* Fiber.interrupt(eventsFiber).pipe(Effect.ignore);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("bridges select UI and cancels unsupported editor UI", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => writeFakePi());
      const adapter = yield* makePiAdapter(decodePiSettings({ binaryPath }));
      const threadId = ThreadId.make("thread-pi-ui");

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* subscribeEvents(adapter.streamEvents, threadId, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(() => {
            if (event.type === "user-input.requested") {
              return Deferred.succeed(requested, event).pipe(Effect.ignore);
            }
            if (event.type === "turn.completed") {
              return Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
            }
            return Effect.void;
          }),
        ),
      );

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "ask-ui" });

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions[0]?.id, "select");
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { select: "A" },
      );
      yield* Deferred.await(turnCompleted);
      assert.ok(runtimeEvents.some((event) => event.type === "user-input.resolved"));

      const editorWarning = yield* Deferred.make<void>();
      const editorCompleted = yield* Deferred.make<void>();
      // Reuse same subscription — wait for next turn completion / warning.
      const editorFiber = yield* subscribeEvents(adapter.streamEvents, threadId, (event) => {
        if (
          event.type === "runtime.warning" &&
          event.payload.message.includes("multiline editor")
        ) {
          return Deferred.succeed(editorWarning, undefined).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(editorCompleted, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      });
      yield* adapter.sendTurn({ threadId, input: "editor-ui" });
      yield* Deferred.await(editorWarning);
      yield* Deferred.await(editorCompleted);

      yield* Fiber.interrupt(eventsFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(editorFiber).pipe(Effect.ignore);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails soft on unknown Pi events and still settles the turn", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => writeFakePi());
      const adapter = yield* makePiAdapter(decodePiSettings({ binaryPath }));
      const threadId = ThreadId.make("thread-pi-unknown");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* subscribeEvents(adapter.streamEvents, threadId, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "unknown-event" });
      yield* Deferred.await(turnCompleted);
      assert.ok(runtimeEvents.some((event) => event.type === "content.delta"));
      assert.ok(runtimeEvents.some((event) => event.type === "turn.completed"));
      yield* Fiber.interrupt(eventsFiber).pipe(Effect.ignore);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cleans up when start fails on a bad binary", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        decodePiSettings({ binaryPath: "/definitely/missing/pi" }),
      );
      const threadId = ThreadId.make("thread-pi-missing");
      const result = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const has = yield* adapter.hasSession(threadId);
      assert.equal(has, false);
    }),
  );
});
