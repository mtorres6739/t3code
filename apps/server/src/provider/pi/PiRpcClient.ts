/**
 * Subprocess JSONL RPC client for `pi --mode rpc`.
 *
 * Framing is LF-only (see {@link ./PiJsonl.ts}). Requests correlate by optional
 * `id`. Child lifecycle is owned by the returned client — callers must
 * `dispose()` on spawn/start/send failure paths.
 *
 * @module provider/pi/PiRpcClient
 */
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  consumePiJsonlRecords,
  encodePiJsonlRecord,
  isRecord,
  tryParsePiJsonlRecord,
} from "./PiJsonl.ts";
import type { PiModel, PiRpcOutbound, PiRpcResponse, PiThinkingLevel } from "./PiRpcTypes.ts";
import { isPiThinkingLevel, parsePiModelSlug, piModelSlug } from "./PiRpcTypes.ts";

const DEFAULT_COMMAND_TIMEOUT = Duration.seconds(30);
const DEFAULT_DISCOVERY_TIMEOUT = Duration.seconds(20);

export class PiRpcClientError extends Data.TaggedError("PiRpcClientError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** Positional helper so call sites stay compact at the adapter boundary. */
export function piRpcClientError(detail: string, cause?: unknown): PiRpcClientError {
  return new PiRpcClientError(cause === undefined ? { detail } : { detail, cause });
}

export interface PiRpcSpawnOptions {
  readonly binaryPath: string;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly extraArgs?: ReadonlyArray<string> | undefined;
  readonly commandTimeout?: Duration.Input | undefined;
}

export interface PiRpcClient {
  /**
   * Send a command and wait for the correlated `type: "response"` record.
   */
  readonly send: (
    command: PiRpcOutbound,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<PiRpcResponse, PiRpcClientError>;
  /**
   * Write a JSONL record without waiting for a response (e.g. `extension_ui_response`).
   */
  readonly write: (payload: PiRpcOutbound) => Effect.Effect<void, PiRpcClientError>;
  readonly events: Stream.Stream<unknown, never>;
  readonly dispose: () => Effect.Effect<void>;
  readonly isDisposed: () => Effect.Effect<boolean>;
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<PiRpcResponse, PiRpcClientError>;
}

function asPiResponse(value: unknown): PiRpcResponse | undefined {
  if (!isRecord(value) || value.type !== "response") {
    return undefined;
  }
  if (typeof value.command !== "string") {
    return undefined;
  }
  if (typeof value.success !== "boolean") {
    return undefined;
  }
  return {
    type: "response",
    command: value.command,
    success: value.success,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(value.data !== undefined ? { data: value.data } : {}),
  };
}

function parsePiModel(value: unknown): PiModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  if (!id || !provider) return undefined;
  return {
    id,
    provider,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    ...(typeof value.contextWindow === "number" ? { contextWindow: value.contextWindow } : {}),
    ...(typeof value.maxTokens === "number" ? { maxTokens: value.maxTokens } : {}),
    ...(typeof value.api === "string" ? { api: value.api } : {}),
    ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
    ...(Array.isArray(value.input)
      ? { input: value.input.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    ...(isRecord(value.thinkingLevelMap)
      ? {
          thinkingLevelMap: Object.fromEntries(
            Object.entries(value.thinkingLevelMap).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        }
      : {}),
  };
}

export function parsePiModelsFromResponse(data: unknown): ReadonlyArray<PiModel> {
  if (!isRecord(data)) return [];
  const models = data.models;
  if (!Array.isArray(models)) return [];
  const out: PiModel[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    const model = parsePiModel(entry);
    if (!model) continue;
    const slug = piModelSlug(model);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(model);
  }
  return out;
}

export function parsePiThinkingLevelsFromResponse(data: unknown): ReadonlyArray<PiThinkingLevel> {
  if (!isRecord(data) || !Array.isArray(data.levels)) {
    return [];
  }
  const levels: PiThinkingLevel[] = [];
  for (const entry of data.levels) {
    if (typeof entry === "string" && isPiThinkingLevel(entry) && !levels.includes(entry)) {
      levels.push(entry);
    }
  }
  return levels;
}

export function parsePiModelFromState(data: unknown): PiModel | undefined {
  if (!isRecord(data)) return undefined;
  return parsePiModel(data.model);
}

export const spawnPiRpcClient = Effect.fn("spawnPiRpcClient")(function* (
  options: PiRpcSpawnOptions,
): Effect.fn.Return<
  PiRpcClient,
  PiRpcClientError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const binaryPath = options.binaryPath.trim() || "pi";
  const args = ["--mode", "rpc", ...(options.extraArgs ?? [])];
  const commandTimeout = options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT;

  const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, {
    ...(options.env ? { env: options.env, extendEnv: true } : {}),
  }).pipe(
    Effect.mapError((cause) =>
      piRpcClientError(`Failed to resolve Pi binary '${binaryPath}'.`, cause),
    ),
  );

  // Pi RPC is a long-lived JSONL session: many requests share one stdin pipe.
  // Effect's ChildProcess defaults endOnDone=true, which closes stdin after the
  // first Stream.run and leaves subsequent writes hanging with no response.
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env, extendEnv: true } : {}),
        shell: spawnCommand.shell,
        stdin: {
          stream: "pipe",
          endOnDone: false,
        },
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        piRpcClientError(`Failed to spawn Pi RPC process '${binaryPath}'.`, cause),
      ),
    );

  const pendingRef = yield* Ref.make(new Map<string, PendingRequest>());
  const eventQueue = yield* Queue.unbounded<unknown>();
  const disposedRef = yield* Ref.make(false);
  const nextIdRef = yield* Ref.make(0);
  const bufferRef = yield* Ref.make("");

  const failAllPending = (error: PiRpcClientError) =>
    Effect.gen(function* () {
      const pending = yield* Ref.getAndSet(pendingRef, new Map());
      yield* Effect.forEach(
        pending.values(),
        (entry) => Deferred.fail(entry.deferred, error).pipe(Effect.ignore),
        { discard: true },
      );
    });

  const markDisposed = Effect.gen(function* () {
    const already = yield* Ref.getAndSet(disposedRef, true);
    if (already) {
      return false;
    }
    yield* failAllPending(piRpcClientError("Pi RPC process closed."));
    yield* Queue.shutdown(eventQueue).pipe(Effect.ignore);
    return true;
  });

  const handleStdoutRecord = (record: string) =>
    Effect.gen(function* () {
      const parsed = tryParsePiJsonlRecord(record);
      if (parsed === undefined) {
        return;
      }

      const response = asPiResponse(parsed);
      if (response) {
        const id = response.id;
        if (id) {
          const pending = yield* Ref.get(pendingRef);
          const entry = pending.get(id);
          if (entry) {
            const next = new Map(pending);
            next.delete(id);
            yield* Ref.set(pendingRef, next);
            yield* Deferred.succeed(entry.deferred, response);
            return;
          }
        }
        // Unsolicited response — surface as an event for diagnostics.
        yield* Queue.offer(eventQueue, parsed);
        return;
      }

      yield* Queue.offer(eventQueue, parsed);
    });

  const stdoutFiber = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(bufferRef);
        const combined = previous + chunk;
        const { records, rest } = consumePiJsonlRecords(combined);
        yield* Ref.set(bufferRef, rest);
        yield* Effect.forEach(records, handleStdoutRecord, { discard: true });
      }),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  const exitFiber = yield* child.exitCode.pipe(
    Effect.exit,
    Effect.flatMap((exit) =>
      Effect.gen(function* () {
        const code = Exit.isSuccess(exit) ? Number(exit.value) : undefined;
        yield* markDisposed;
        yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
        if (code !== undefined && code !== 0) {
          yield* failAllPending(piRpcClientError(`Pi RPC process exited with code ${code}.`)).pipe(
            Effect.ignore,
          );
        }
      }),
    ),
    Effect.forkScoped,
  );

  const writeLine = (payload: unknown): Effect.Effect<void, PiRpcClientError> =>
    Effect.gen(function* () {
      if (yield* Ref.get(disposedRef)) {
        return yield* piRpcClientError("Pi RPC process is already disposed.");
      }
      const line = encodePiJsonlRecord(payload);
      yield* Stream.run(Stream.encodeText(Stream.make(line)), child.stdin).pipe(
        Effect.mapError((cause) => piRpcClientError("Failed to write Pi RPC command.", cause)),
      );
    });

  const write: PiRpcClient["write"] = (payload) => writeLine(payload);

  const send: PiRpcClient["send"] = (command, sendOptions) =>
    Effect.gen(function* () {
      if (yield* Ref.get(disposedRef)) {
        return yield* piRpcClientError("Pi RPC process is already disposed.");
      }

      // extension_ui_response is a client→agent reply, not a command. Do not wait.
      if (command.type === "extension_ui_response") {
        yield* writeLine(command);
        return {
          type: "response" as const,
          command: "extension_ui_response",
          success: true,
          ...(typeof command.id === "string" ? { id: command.id } : {}),
        };
      }

      const seq = yield* Ref.updateAndGet(nextIdRef, (n) => n + 1);
      const id =
        typeof command.id === "string" && command.id.trim().length > 0
          ? command.id
          : `pi-req-${seq}`;
      const payload = { ...command, id };

      const deferred = yield* Deferred.make<PiRpcResponse, PiRpcClientError>();
      yield* Ref.update(pendingRef, (map) => {
        const next = new Map(map);
        next.set(id, { deferred });
        return next;
      });

      yield* writeLine(payload).pipe(
        Effect.tapError(() =>
          Ref.update(pendingRef, (map) => {
            const next = new Map(map);
            next.delete(id);
            return next;
          }).pipe(Effect.andThen(Deferred.fail(deferred, piRpcClientError("write failed")))),
        ),
      );

      const timeout = sendOptions?.timeout ?? commandTimeout;
      const result = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap((option) => {
          if (Option.isNone(option)) {
            return Ref.update(pendingRef, (map) => {
              const next = new Map(map);
              next.delete(id);
              return next;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  piRpcClientError(`Pi RPC command '${String(command.type)}' timed out.`),
                ),
              ),
            );
          }
          return Effect.succeed(option.value);
        }),
      );

      if (!result.success) {
        return yield* piRpcClientError(
          result.error?.trim() ||
            `Pi RPC command '${result.command}' failed without an error message.`,
        );
      }
      return result;
    });

  const dispose: PiRpcClient["dispose"] = () =>
    Effect.gen(function* () {
      yield* markDisposed;
      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
      yield* child.kill().pipe(Effect.ignore);
    });

  yield* Scope.addFinalizer(yield* Scope.Scope, dispose());

  return {
    send,
    write,
    events: Stream.fromQueue(eventQueue),
    dispose,
    isDisposed: () => Ref.get(disposedRef),
  } satisfies PiRpcClient;
});

export interface PiDiscoveryResult {
  readonly models: ReadonlyArray<PiModel>;
  readonly thinkingLevelsBySlug: ReadonlyMap<string, ReadonlyArray<PiThinkingLevel>>;
  readonly currentModel: PiModel | undefined;
  readonly currentThinkingLevels: ReadonlyArray<PiThinkingLevel>;
}

/**
 * Short-lived RPC session used for provider probes: models + thinking levels.
 * Always disposes the child, including on failure.
 */
export const discoverPiModels = Effect.fn("discoverPiModels")(function* (
  options: PiRpcSpawnOptions,
): Effect.fn.Return<
  PiDiscoveryResult,
  PiRpcClientError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const client = yield* spawnPiRpcClient({
    ...options,
    extraArgs: ["--no-session", ...(options.extraArgs ?? [])],
    commandTimeout: options.commandTimeout ?? DEFAULT_DISCOVERY_TIMEOUT,
  });

  return yield* Effect.gen(function* () {
    const modelsResponse = yield* client.send({ type: "get_available_models" });
    const models = parsePiModelsFromResponse(modelsResponse.data);

    const stateResponse = yield* client.send({ type: "get_state" }).pipe(
      Effect.orElseSucceed(() => ({
        type: "response" as const,
        command: "get_state",
        success: true,
        data: {},
      })),
    );
    const currentModel = parsePiModelFromState(stateResponse.data);

    const thinkingResponse = yield* client.send({ type: "get_available_thinking_levels" }).pipe(
      Effect.orElseSucceed(() => ({
        type: "response" as const,
        command: "get_available_thinking_levels",
        success: true,
        data: { levels: [] },
      })),
    );
    const currentThinkingLevels = parsePiThinkingLevelsFromResponse(thinkingResponse.data);

    const thinkingLevelsBySlug = new Map<string, ReadonlyArray<PiThinkingLevel>>();
    if (currentModel) {
      thinkingLevelsBySlug.set(piModelSlug(currentModel), currentThinkingLevels);
    }
    // Real RPC levels for the active model are applied to other reasoning models
    // so the picker has non-empty options without N set_model round-trips.
    // Session start/set_model still re-fetches levels for the selected model.
    for (const model of models) {
      const slug = piModelSlug(model);
      if (thinkingLevelsBySlug.has(slug)) continue;
      if (model.reasoning === false) {
        thinkingLevelsBySlug.set(slug, ["off"]);
      } else if (currentThinkingLevels.length > 0) {
        thinkingLevelsBySlug.set(slug, currentThinkingLevels);
      } else {
        thinkingLevelsBySlug.set(slug, []);
      }
    }

    return {
      models,
      thinkingLevelsBySlug,
      currentModel,
      currentThinkingLevels,
    } satisfies PiDiscoveryResult;
  }).pipe(Effect.ensuring(client.dispose()));
});

export const setPiModelAndThinking = Effect.fn("setPiModelAndThinking")(function* (
  client: PiRpcClient,
  input: {
    readonly modelSlug?: string | undefined;
    readonly thinkingLevel?: string | undefined;
  },
): Effect.fn.Return<
  {
    readonly model: PiModel | undefined;
    readonly thinkingLevels: ReadonlyArray<PiThinkingLevel>;
  },
  PiRpcClientError
> {
  let model: PiModel | undefined;
  if (input.modelSlug) {
    const parsed = parsePiModelSlug(input.modelSlug);
    if (!parsed) {
      return yield* piRpcClientError(
        `Invalid Pi model slug '${input.modelSlug}'. Expected 'provider/id'.`,
      );
    }
    const response = yield* client.send({
      type: "set_model",
      provider: parsed.provider,
      modelId: parsed.modelId,
    });
    model = parsePiModel(response.data) ?? {
      id: parsed.modelId,
      provider: parsed.provider,
    };
  }

  const thinkingResponse = yield* client.send({ type: "get_available_thinking_levels" }).pipe(
    Effect.orElseSucceed(() => ({
      type: "response" as const,
      command: "get_available_thinking_levels",
      success: true,
      data: { levels: [] as const },
    })),
  );
  const thinkingLevels = parsePiThinkingLevelsFromResponse(thinkingResponse.data);

  if (input.thinkingLevel && isPiThinkingLevel(input.thinkingLevel)) {
    if (thinkingLevels.length === 0 || thinkingLevels.includes(input.thinkingLevel)) {
      yield* client.send({
        type: "set_thinking_level",
        level: input.thinkingLevel,
      });
    }
  }

  return { model, thinkingLevels };
});
