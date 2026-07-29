/**
 * Pi adapter — JSONL RPC session lifecycle mapped to T3 runtime events.
 *
 * Critical invariants:
 * - Exactly one T3 turn lifecycle per accepted send (not per Pi turn_start).
 * - Assistant items open lazily on the first visible text/thinking delta.
 * - Tool-only intermediate messages never create empty assistant bubbles.
 * - `agent_settled` is the normal terminal signal (`agent_end` is not).
 * - Interrupt maps to `abort`.
 * - Unknown Pi events fail soft.
 * - Extension select/confirm/input bridge; editor is cancelled with a message.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type PiSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  canonicalItemTypeFromPiToolName,
  summarizePiToolResult,
  toolTitleFromPiArgs,
} from "../pi/PiEventMapping.ts";
import { isRecord } from "../pi/PiJsonl.ts";
import { setPiModelAndThinking, spawnPiRpcClient, type PiRpcClient } from "../pi/PiRpcClient.ts";
import { parsePiModelSlug } from "../pi/PiRpcTypes.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_RESUME_VERSION = 1 as const;
const EDITOR_UNSUPPORTED_MESSAGE =
  "Pi multiline editor UI is not supported in T3 Code v1. Use select/confirm/input instead.";

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly piRequestId: string;
  readonly method: "select" | "confirm" | "input";
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface OpenAssistantItem {
  readonly itemId: RuntimeItemId;
  readonly kind: "assistant_message" | "reasoning";
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  client: PiRpcClient;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  interruptedTurnIds: Set<TurnId>;
  openAssistant: OpenAssistantItem | undefined;
  openTools: Map<string, RuntimeItemId>;
  currentModelSlug: string | undefined;
  stopped: boolean;
}

function nowIso() {
  return Effect.map(DateTime.now, DateTime.formatIso);
}

function parsePiResume(raw: unknown): { sessionHint?: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== PI_RESUME_VERSION) return undefined;
  return {
    ...(typeof raw.sessionHint === "string" ? { sessionHint: raw.sessionHint } : {}),
  };
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    void (yield* Path.Path);

    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "unknown",
            detail: "Failed to generate UUID.",
            cause,
          }),
      ),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const stamp = Effect.gen(function* () {
      const eventId = EventId.make(yield* randomUUIDv4);
      const createdAt = yield* nowIso();
      return { eventId, createdAt };
    });

    const logNative = (threadId: ThreadId, payload: unknown) => {
      if (!nativeEventLogger) return Effect.void;
      return nativeEventLogger.write(payload, threadId).pipe(Effect.ignore);
    };

    const ensureSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return ctx;
      });

    const settlePendingUserInputs = (ctx: PiSessionContext) =>
      Effect.forEach(
        Array.from(ctx.pendingUserInputs.values()),
        (pending) =>
          Deferred.succeed(pending.resolution, { _tag: "cancelled" as const }).pipe(Effect.ignore),
        { discard: true },
      ).pipe(Effect.andThen(Effect.sync(() => ctx.pendingUserInputs.clear())));

    const completeOpenAssistant = (ctx: PiSessionContext, turnId: TurnId | undefined) =>
      Effect.gen(function* () {
        if (!ctx.openAssistant || !turnId) return;
        const item = ctx.openAssistant;
        ctx.openAssistant = undefined;
        yield* emit({
          ...(yield* stamp),
          type: "item.completed",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: item.itemId,
          payload: {
            itemType: item.kind,
            status: "completed",
          },
          raw: { source: "pi.rpc", method: "assistant.close", payload: {} },
        });
      });

    const ensureAssistantOpen = (
      ctx: PiSessionContext,
      turnId: TurnId,
      kind: "assistant_message" | "reasoning",
    ) =>
      Effect.gen(function* () {
        if (ctx.openAssistant?.kind === kind) {
          return ctx.openAssistant.itemId;
        }
        if (ctx.openAssistant && ctx.openAssistant.kind !== kind) {
          yield* completeOpenAssistant(ctx, turnId);
        }
        const itemId = RuntimeItemId.make(`pi-assistant-${yield* randomUUIDv4}`);
        ctx.openAssistant = { itemId, kind };
        yield* emit({
          ...(yield* stamp),
          type: "item.started",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId,
          payload: {
            itemType: kind,
            status: "inProgress",
          },
          raw: { source: "pi.rpc", method: "assistant.open", payload: { kind } },
        });
        return itemId;
      });

    const terminateTurn = (
      ctx: PiSessionContext,
      input: {
        readonly turnId: TurnId;
        readonly state: "completed" | "failed" | "interrupted" | "cancelled";
        readonly errorMessage?: string;
      },
    ) =>
      Effect.gen(function* () {
        yield* completeOpenAssistant(ctx, input.turnId);
        for (const [toolCallId, itemId] of ctx.openTools) {
          yield* emit({
            ...(yield* stamp),
            type: "item.completed",
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: input.turnId,
            itemId,
            payload: {
              itemType: "dynamic_tool_call",
              status: input.state === "completed" ? "completed" : "failed",
              detail: "Tool interrupted by turn settlement.",
              data: { toolCallId },
            },
            raw: { source: "pi.rpc", method: "tool.force_close", payload: { toolCallId } },
          });
        }
        ctx.openTools.clear();

        if (ctx.activeTurnId === input.turnId) {
          ctx.activeTurnId = undefined;
        }
        ctx.interruptedTurnIds.delete(input.turnId);
        ctx.session = {
          ...ctx.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso(),
          ...(input.errorMessage ? { lastError: input.errorMessage } : {}),
        };

        // Publish the terminal event only after internal state is settled so a
        // subscriber can immediately start the next turn without racing this
        // handler's cleanup.
        yield* emit({
          ...(yield* stamp),
          type: "turn.completed",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: input.turnId,
          payload: {
            state: input.state,
            ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
          },
          raw: { source: "pi.rpc", method: "agent_settled", payload: {} },
        });
      });

    const writeExtensionUiResponse = (
      client: PiRpcClient,
      response: {
        readonly id: string;
        readonly value?: string;
        readonly confirmed?: boolean;
        readonly cancelled?: boolean;
      },
    ) =>
      client
        .write({
          type: "extension_ui_response",
          id: response.id,
          ...(response.value !== undefined ? { value: response.value } : {}),
          ...(response.confirmed !== undefined ? { confirmed: response.confirmed } : {}),
          ...(response.cancelled !== undefined ? { cancelled: response.cancelled } : {}),
        })
        .pipe(Effect.ignore);

    const handleExtensionUiRequest = (ctx: PiSessionContext, event: Record<string, unknown>) =>
      Effect.gen(function* () {
        const id = typeof event.id === "string" ? event.id : undefined;
        const method = typeof event.method === "string" ? event.method : undefined;
        if (!id || !method) return;

        if (
          method === "notify" ||
          method === "setStatus" ||
          method === "setWidget" ||
          method === "setTitle" ||
          method === "set_editor_text"
        ) {
          yield* logNative(ctx.threadId, { kind: "extension_ui_fire_and_forget", event });
          return;
        }

        if (method === "editor") {
          yield* writeExtensionUiResponse(ctx.client, { id, cancelled: true });
          yield* emit({
            ...(yield* stamp),
            type: "runtime.warning",
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: {
              message: EDITOR_UNSUPPORTED_MESSAGE,
            },
            raw: { source: "pi.rpc", method: "extension_ui_request", payload: event },
          });
          return;
        }

        if (method !== "select" && method !== "confirm" && method !== "input") {
          yield* logNative(ctx.threadId, { kind: "unknown_extension_ui", event });
          yield* writeExtensionUiResponse(ctx.client, { id, cancelled: true });
          return;
        }

        const requestId = ApprovalRequestId.make(`pi-ui-${id}`);
        const resolution = yield* Deferred.make<PendingUserInputResolution>();
        ctx.pendingUserInputs.set(requestId, {
          piRequestId: id,
          method,
          resolution,
        });

        const questions: UserInputQuestion[] =
          method === "confirm"
            ? [
                {
                  id: "confirm",
                  header: typeof event.title === "string" ? event.title : "Confirm",
                  question:
                    typeof event.message === "string"
                      ? event.message
                      : typeof event.title === "string"
                        ? event.title
                        : "Confirm?",
                  options: [
                    { label: "Yes", description: "Confirm" },
                    { label: "No", description: "Cancel" },
                  ],
                  multiSelect: false,
                },
              ]
            : method === "select"
              ? [
                  {
                    id: "select",
                    header: typeof event.title === "string" ? event.title : "Select",
                    question: typeof event.title === "string" ? event.title : "Choose an option",
                    options: Array.isArray(event.options)
                      ? event.options
                          .filter((entry): entry is string => typeof entry === "string")
                          .map((label) => ({ label, description: label }))
                      : [],
                    multiSelect: false,
                  },
                ]
              : [
                  {
                    id: "input",
                    header: typeof event.title === "string" ? event.title : "Input",
                    question:
                      typeof event.title === "string"
                        ? event.title
                        : typeof event.placeholder === "string"
                          ? event.placeholder
                          : "Enter a value",
                    options: [],
                    multiSelect: false,
                  },
                ];

        yield* emit({
          ...(yield* stamp),
          type: "user-input.requested",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { questions },
          raw: { source: "pi.rpc", method: "extension_ui_request", payload: event },
        });

        yield* Effect.gen(function* () {
          const answered = yield* Deferred.await(resolution);
          ctx.pendingUserInputs.delete(requestId);
          if (answered._tag === "cancelled") {
            yield* writeExtensionUiResponse(ctx.client, { id, cancelled: true });
            yield* emit({
              ...(yield* stamp),
              type: "user-input.resolved",
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              requestId: RuntimeRequestId.make(requestId),
              payload: { answers: {} },
              raw: {
                source: "pi.rpc",
                method: "extension_ui_response",
                payload: { cancelled: true },
              },
            });
            return;
          }

          if (method === "confirm") {
            const raw = answered.answers.confirm;
            const confirmed =
              raw === true ||
              raw === "Yes" ||
              raw === "yes" ||
              (Array.isArray(raw) && raw.includes("Yes"));
            yield* writeExtensionUiResponse(ctx.client, { id, confirmed });
          } else if (method === "select") {
            const raw = answered.answers.select;
            const value = Array.isArray(raw)
              ? String(raw[0] ?? "")
              : typeof raw === "string"
                ? raw
                : "";
            yield* writeExtensionUiResponse(ctx.client, { id, value });
          } else {
            const raw = answered.answers.input;
            const value = typeof raw === "string" ? raw : String(raw ?? "");
            yield* writeExtensionUiResponse(ctx.client, { id, value });
          }

          yield* emit({
            ...(yield* stamp),
            type: "user-input.resolved",
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: answered.answers as Record<string, unknown> },
            raw: {
              source: "pi.rpc",
              method: "extension_ui_response",
              payload: answered.answers,
            },
          });
        }).pipe(Effect.forkIn(ctx.scope), Effect.asVoid);
      });

    const handlePiEvent = (ctx: PiSessionContext, event: unknown) =>
      Effect.gen(function* () {
        yield* logNative(ctx.threadId, event);
        if (!isRecord(event)) return;

        const type = typeof event.type === "string" ? event.type : undefined;
        if (!type) return;

        if (type === "extension_ui_request") {
          yield* handleExtensionUiRequest(ctx, event);
          return;
        }

        const turnId = ctx.activeTurnId;

        switch (type) {
          case "agent_start":
          case "turn_start":
          case "turn_end":
          case "queue_update":
          case "compaction_start":
          case "compaction_end":
          case "auto_retry_start":
          case "auto_retry_end":
          case "summarization_retry_scheduled":
          case "summarization_retry_attempt_start":
          case "summarization_retry_finished":
          case "bash_execution_update":
          case "message_start":
          case "message_end":
            return;

          case "agent_end":
            // Not terminal — wait for agent_settled (retry/continuation may remain).
            return;

          case "agent_settled": {
            if (!turnId) return;
            if (ctx.interruptedTurnIds.has(turnId)) {
              yield* terminateTurn(ctx, {
                turnId,
                state: "interrupted",
              });
              return;
            }
            yield* terminateTurn(ctx, { turnId, state: "completed" });
            return;
          }

          case "message_update": {
            if (!turnId) return;
            const assistantEvent = isRecord(event.assistantMessageEvent)
              ? event.assistantMessageEvent
              : undefined;
            if (!assistantEvent) return;
            const deltaType =
              typeof assistantEvent.type === "string" ? assistantEvent.type : undefined;
            if (deltaType === "text_delta" && typeof assistantEvent.delta === "string") {
              if (assistantEvent.delta.length === 0) return;
              const itemId = yield* ensureAssistantOpen(ctx, turnId, "assistant_message");
              yield* emit({
                ...(yield* stamp),
                type: "content.delta",
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: ctx.threadId,
                turnId,
                itemId,
                payload: {
                  streamKind: "assistant_text",
                  delta: assistantEvent.delta,
                  ...(typeof assistantEvent.contentIndex === "number"
                    ? { contentIndex: assistantEvent.contentIndex }
                    : {}),
                },
                raw: { source: "pi.rpc", method: "message_update", payload: event },
              });
              return;
            }
            if (deltaType === "thinking_delta" && typeof assistantEvent.delta === "string") {
              if (assistantEvent.delta.length === 0) return;
              const itemId = yield* ensureAssistantOpen(ctx, turnId, "reasoning");
              yield* emit({
                ...(yield* stamp),
                type: "content.delta",
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: ctx.threadId,
                turnId,
                itemId,
                payload: {
                  streamKind: "reasoning_text",
                  delta: assistantEvent.delta,
                },
                raw: { source: "pi.rpc", method: "message_update", payload: event },
              });
              return;
            }
            if (deltaType === "text_end" || deltaType === "thinking_end" || deltaType === "done") {
              yield* completeOpenAssistant(ctx, turnId);
              return;
            }
            if (deltaType === "error") {
              const reason =
                typeof assistantEvent.reason === "string" ? assistantEvent.reason : "error";
              if (reason === "aborted") {
                ctx.interruptedTurnIds.add(turnId);
              }
              return;
            }
            return;
          }

          case "tool_execution_start": {
            if (!turnId) return;
            yield* completeOpenAssistant(ctx, turnId);
            const toolCallId =
              typeof event.toolCallId === "string" ? event.toolCallId : yield* randomUUIDv4;
            const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
            const itemId = RuntimeItemId.make(toolCallId);
            ctx.openTools.set(toolCallId, itemId);
            const itemType = canonicalItemTypeFromPiToolName(toolName);
            const title = toolTitleFromPiArgs(toolName, event.args);
            yield* emit({
              ...(yield* stamp),
              type: "item.started",
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              turnId,
              itemId,
              payload: {
                itemType,
                status: "inProgress",
                ...(title ? { title } : {}),
                data: {
                  toolCallId,
                  toolName,
                  args: event.args,
                },
              },
              raw: { source: "pi.rpc", method: "tool_execution_start", payload: event },
            });
            return;
          }

          case "tool_execution_update": {
            if (!turnId) return;
            const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
            if (!toolCallId) return;
            const itemId = ctx.openTools.get(toolCallId) ?? RuntimeItemId.make(toolCallId);
            const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
            const summary = summarizePiToolResult(event.partialResult);
            yield* emit({
              ...(yield* stamp),
              type: "tool.progress",
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              turnId,
              itemId,
              payload: {
                toolUseId: toolCallId,
                toolName,
                ...(summary ? { summary } : {}),
              },
              raw: { source: "pi.rpc", method: "tool_execution_update", payload: event },
            });
            return;
          }

          case "tool_execution_end": {
            if (!turnId) return;
            const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
            if (!toolCallId) return;
            const itemId = ctx.openTools.get(toolCallId) ?? RuntimeItemId.make(toolCallId);
            ctx.openTools.delete(toolCallId);
            const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
            const isError = event.isError === true;
            const summary = summarizePiToolResult(event.result);
            yield* emit({
              ...(yield* stamp),
              type: "item.completed",
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              turnId,
              itemId,
              payload: {
                itemType: canonicalItemTypeFromPiToolName(toolName),
                status: isError ? "failed" : "completed",
                ...(summary ? { detail: summary } : {}),
                data: {
                  toolCallId,
                  toolName,
                  result: event.result,
                  isError,
                },
              },
              raw: { source: "pi.rpc", method: "tool_execution_end", payload: event },
            });
            return;
          }

          case "extension_error": {
            yield* emit({
              ...(yield* stamp),
              type: "runtime.warning",
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              turnId,
              payload: {
                message:
                  typeof event.error === "string"
                    ? event.error
                    : "A Pi extension reported an error.",
              },
              raw: { source: "pi.rpc", method: "extension_error", payload: event },
            });
            return;
          }

          default: {
            // Unknown future Pi events fail soft.
            yield* logNative(ctx.threadId, { kind: "unknown_pi_event", event });
            return;
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Pi event handler failed soft", { cause: String(cause) }),
        ),
      );

    const failSessionFromProcessExit = (ctx: PiSessionContext, detail: string) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        if (ctx.activeTurnId) {
          yield* terminateTurn(ctx, {
            turnId: ctx.activeTurnId,
            state: "failed",
            errorMessage: detail,
          });
        }
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso(),
          lastError: detail,
        };
        yield* emit({
          ...(yield* stamp),
          type: "session.exited",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          payload: {
            reason: detail,
            recoverable: false,
            exitKind: "error",
          },
          raw: { source: "pi.rpc", method: "process.exit", payload: { detail } },
        });
        sessions.delete(ctx.threadId);
        yield* ctx.client.dispose();
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      });

    const startEventLoop = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        const fiber = yield* ctx.client.events.pipe(
          Stream.runForEach((event) => handlePiEvent(ctx, event)),
          Effect.catchCause((cause) =>
            failSessionFromProcessExit(ctx, `Pi RPC event stream closed: ${String(cause)}`),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              if (ctx.stopped || !sessions.has(ctx.threadId)) return;
              // Process exited or event stream ended without an error cause.
              if (ctx.activeTurnId || (yield* ctx.client.isDisposed())) {
                yield* failSessionFromProcessExit(ctx, "Pi RPC process exited.");
              }
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Pi event loop cleanup failed", { cause: String(cause) }),
          ),
          Effect.forkIn(ctx.scope),
        );
        ctx.eventFiber = fiber;
      });

    const startSession: PiAdapterShape["startSession"] = Effect.fn("PiAdapter.startSession")(
      function* (input) {
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          return existing.session;
        }

        const createdAt = yield* nowIso();
        const modelSlug = input.modelSelection?.model;
        if (
          modelSlug &&
          input.modelSelection &&
          input.modelSelection.instanceId !== boundInstanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Model selection is bound to instance '${input.modelSelection.instanceId}', expected '${boundInstanceId}'.`,
          });
        }

        const sessionScope = yield* Scope.make();
        const client = yield* spawnPiRpcClient({
          binaryPath: piSettings.binaryPath || "pi",
          ...(input.cwd ? { cwd: input.cwd } : {}),
          env: options?.environment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (error) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: error.detail,
                cause: error,
              }),
          ),
          Effect.tapError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)),
        );

        if (modelSlug) {
          const thinking = getModelSelectionStringOptionValue(input.modelSelection, "thinking");
          yield* setPiModelAndThinking(client, {
            modelSlug,
            ...(thinking ? { thinkingLevel: thinking } : {}),
          }).pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "set_model",
                  detail: error.detail,
                  cause: error,
                }),
            ),
            Effect.tapError(() =>
              client
                .dispose()
                .pipe(Effect.andThen(Scope.close(sessionScope, Exit.void).pipe(Effect.ignore))),
            ),
          );
        }

        const resume = parsePiResume(input.resumeCursor);
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(modelSlug ? { model: modelSlug } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: PI_RESUME_VERSION,
            ...(resume?.sessionHint ? { sessionHint: resume.sessionHint } : {}),
          },
          createdAt,
          updatedAt: createdAt,
        };

        const ctx: PiSessionContext = {
          threadId: input.threadId,
          session,
          scope: sessionScope,
          client,
          eventFiber: undefined,
          pendingUserInputs: new Map(),
          turns: [],
          activeTurnId: undefined,
          interruptedTurnIds: new Set(),
          openAssistant: undefined,
          openTools: new Map(),
          currentModelSlug: modelSlug,
          stopped: false,
        };
        sessions.set(input.threadId, ctx);
        yield* startEventLoop(ctx);

        yield* emit({
          ...(yield* stamp),
          type: "session.started",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: {
            message: "Pi RPC session started.",
            resume: session.resumeCursor,
          },
          raw: { source: "pi.rpc", method: "session.start", payload: {} },
        });

        return session;
      },
    );

    const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("PiAdapter.sendTurn")(function* (input) {
      const ctx = yield* ensureSession(input.threadId);
      const steeringTurnId = ctx.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`pi-turn-${yield* randomUUIDv4}`);

      const modelSelection =
        input.modelSelection ??
        (ctx.session.model ? { instanceId: boundInstanceId, model: ctx.session.model } : undefined);

      if (modelSelection && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }

      if (modelSelection?.model && modelSelection.model !== ctx.currentModelSlug) {
        if (!parsePiModelSlug(modelSelection.model)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi model selection must use the 'provider/id' format.",
          });
        }
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        yield* setPiModelAndThinking(ctx.client, {
          modelSlug: modelSelection.model,
          ...(thinking ? { thinkingLevel: thinking } : {}),
        }).pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "set_model",
                detail: error.detail,
                cause: error,
              }),
          ),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              ctx.session = {
                ...ctx.session,
                status: "ready",
                updatedAt: yield* nowIso(),
                lastError: error.detail,
              };
            }),
          ),
        );
        ctx.currentModelSlug = modelSelection.model;
        ctx.session = {
          ...ctx.session,
          model: modelSelection.model,
          updatedAt: yield* nowIso(),
        };
      } else if (modelSelection) {
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        if (thinking) {
          yield* setPiModelAndThinking(ctx.client, {
            thinkingLevel: thinking,
          }).pipe(Effect.ignore);
        }
      }

      const text = input.input?.trim() ?? "";
      const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      if (input.attachments && input.attachments.length > 0) {
        for (const attachment of input.attachments) {
          const filePath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!filePath) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Failed to resolve attachment path for '${attachment.id}'.`,
            });
          }
          const data = yield* fileSystem.readFile(filePath).pipe(
            Effect.map((bytes) => Buffer.from(bytes).toString("base64")),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: `Failed to read attachment '${attachment.id}'.`,
                  cause,
                }),
            ),
          );
          const mimeType =
            (typeof attachment.mimeType === "string" && attachment.mimeType.trim()) || "image/png";
          images.push({ type: "image", data, mimeType });
        }
      }

      if (!text && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi turns require text input or at least one attachment.",
        });
      }

      ctx.activeTurnId = turnId;
      ctx.session = {
        ...ctx.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* nowIso(),
      };

      if (steeringTurnId === undefined) {
        ctx.turns = [...ctx.turns, { id: turnId, items: [] }];
        const effort = getModelSelectionStringOptionValue(modelSelection, "thinking");
        yield* emit({
          ...(yield* stamp),
          type: "turn.started",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: {
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(effort ? { effort } : {}),
          },
          raw: { source: "pi.rpc", method: "prompt", payload: { message: text } },
        });
      }

      const promptCommand =
        steeringTurnId !== undefined
          ? {
              type: "prompt" as const,
              message: text,
              streamingBehavior: "steer" as const,
              ...(images.length > 0 ? { images } : {}),
            }
          : {
              type: "prompt" as const,
              message: text,
              ...(images.length > 0 ? { images } : {}),
            };

      yield* ctx.client.send(promptCommand).pipe(
        Effect.mapError(
          (error) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: error.detail,
              cause: error,
            }),
        ),
        Effect.tapError((error) =>
          steeringTurnId !== undefined
            ? Effect.void
            : terminateTurn(ctx, {
                turnId,
                state: "failed",
                errorMessage: error.detail,
              }),
        ),
      );

      return {
        threadId: input.threadId,
        turnId,
        ...(ctx.session.resumeCursor !== undefined
          ? { resumeCursor: ctx.session.resumeCursor }
          : {}),
      };
    });

    const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("PiAdapter.interruptTurn")(
      function* (threadId, turnId) {
        const ctx = yield* ensureSession(threadId);
        const targetTurnId = turnId ?? ctx.activeTurnId;
        if (targetTurnId) {
          ctx.interruptedTurnIds.add(targetTurnId);
        }
        // Unblock any extension UI waiters so abort cannot deadlock Pi.
        yield* settlePendingUserInputs(ctx);

        const disposed = yield* ctx.client.isDisposed();
        if (!disposed) {
          yield* ctx.client.send({ type: "abort" }).pipe(Effect.catch(() => Effect.void));
        }

        // If the process is already gone, settle immediately so the UI is not stuck.
        if (targetTurnId && ctx.activeTurnId === targetTurnId && disposed) {
          yield* terminateTurn(ctx, {
            turnId: targetTurnId,
            state: "interrupted",
          });
        }
      },
    );

    const respondToRequest: PiAdapterShape["respondToRequest"] = Effect.fn(
      "PiAdapter.respondToRequest",
    )(function* (threadId, _requestId, _decision: ProviderApprovalDecision) {
      yield* ensureSession(threadId);
      // Pi v1 has no fake approval model.
      return;
    });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn(
      "PiAdapter.respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const ctx = yield* ensureSession(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
    });

    const stopSession: PiAdapterShape["stopSession"] = Effect.fn("PiAdapter.stopSession")(
      function* (threadId) {
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        ctx.stopped = true;
        yield* settlePendingUserInputs(ctx);
        if (ctx.activeTurnId) {
          yield* terminateTurn(ctx, {
            turnId: ctx.activeTurnId,
            state: "cancelled",
          });
        }
        yield* ctx.client.dispose();
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(threadId);
        yield* emit({
          ...(yield* stamp),
          type: "session.exited",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload: {
            reason: "Session stopped.",
            recoverable: true,
            exitKind: "graceful",
          },
          raw: { source: "pi.rpc", method: "session.stop", payload: {} },
        });
      },
    );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.succeed(
        Array.from(sessions.values())
          .filter((ctx) => !ctx.stopped)
          .map((ctx) => ctx.session),
      );

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return Boolean(ctx && !ctx.stopped);
      });

    const readThread: PiAdapterShape["readThread"] = Effect.fn("PiAdapter.readThread")(
      function* (threadId) {
        const ctx = yield* ensureSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
        };
      },
    );

    const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("PiAdapter.rollbackThread")(
      function* (threadId, numTurns) {
        const ctx = yield* ensureSession(threadId);
        if (numTurns > 0 && ctx.turns.length > 0) {
          ctx.turns = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
        }
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
        };
      },
    );

    const stopAll: PiAdapterShape["stopAll"] = Effect.fn("PiAdapter.stopAll")(function* () {
      const ids = Array.from(sessions.keys());
      yield* Effect.forEach(ids, (threadId) => stopSession(threadId).pipe(Effect.ignore), {
        discard: true,
      });
      if (managedNativeEventLogger) {
        yield* managedNativeEventLogger.close().pipe(Effect.ignore);
      }
    });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies PiAdapterShape;
  });
}
