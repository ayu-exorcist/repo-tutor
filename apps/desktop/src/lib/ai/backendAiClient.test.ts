import { BackendAiClient } from "$lib/ai/backendAiClient";
import { MessageRole, type Prompt } from "$lib/ai/types";
import type { IBackend } from "$lib/backend/backend";
import { describe, expect, test, vi } from "vitest";

type EventListener = (event: { payload: unknown }) => void;

function createBackend() {
	const listeners = new Map<string, EventListener>();
	const unlisten = vi.fn().mockResolvedValue(undefined);
	const listen = vi.fn((event: string, callback: EventListener) => {
		listeners.set(event, callback);
		return unlisten;
	});
	const invoke = vi.fn();

	return {
		backend: { invoke, listen } as unknown as IBackend,
		invoke,
		listeners,
		unlisten,
	};
}

const prompt: Prompt = [
	{ role: MessageRole.User, content: "Summarize this change." },
	{ role: MessageRole.Assistant, content: "I will review it." },
];

describe("BackendAiClient", () => {
	test("streams matching tokens and unlistens after the invoke response", async () => {
		const { backend, invoke, listeners, unlisten } = createBackend();
		const onToken = vi.fn();
		invoke.mockImplementation(async () => {
			listeners.get("ai://response/token")?.({
				payload: { requestId: "another-request", token: "ignored" },
			});
			const requestId = (invoke.mock.calls[0]?.[1] as { request: { requestId: string } }).request
				.requestId;
			listeners.get("ai://response/token")?.({ payload: { requestId, token: "hello" } });
			return "hello";
		});

		await expect(new BackendAiClient(backend).evaluate(prompt, { onToken })).resolves.toBe("hello");

		expect(onToken).toHaveBeenCalledExactlyOnceWith("hello");
		expect(unlisten).toHaveBeenCalledTimes(3);
	});

	test("waits for completed event when the backend only acknowledges stream startup", async () => {
		const { backend, invoke, listeners } = createBackend();
		invoke.mockImplementation(async () => {
			const requestId = (invoke.mock.calls[0]?.[1] as { request: { requestId: string } }).request
				.requestId;
			queueMicrotask(() => {
				listeners.get("ai://response/completed")?.({
					payload: { requestId, text: "completed response" },
				});
			});
			return { requestId };
		});

		await expect(new BackendAiClient(backend).evaluate(prompt)).resolves.toBe("completed response");
	});

	test("sends only the configured AI transport payload", async () => {
		const { backend, invoke } = createBackend();
		invoke.mockResolvedValue("response");
		const client = new BackendAiClient(backend);

		await client.evaluate(
			[
				{ role: MessageRole.System, content: "First instruction." },
				{ role: MessageRole.User, content: "Question" },
				{ role: MessageRole.System, content: "Second instruction." },
				{ role: MessageRole.Assistant, content: "Answer" },
			],
			{ maxTokens: 42 },
		);

		expect(invoke).toHaveBeenCalledExactlyOnceWith("stream_configured_ai_response", {
			request: {
				requestId: expect.any(String),
				systemMessage: "First instruction.\nSecond instruction.",
				messages: [
					{ role: MessageRole.User, content: "Question" },
					{ role: MessageRole.Assistant, content: "Answer" },
				],
				maxTokens: 42,
			},
		});
	});

	test("rejects failed events for its request and unlistens", async () => {
		const { backend, invoke, listeners, unlisten } = createBackend();
		invoke.mockReturnValue(new Promise<string>(() => {}));
		const evaluation = new BackendAiClient(backend).evaluate(prompt);
		const requestId = (invoke.mock.calls[0]?.[1] as { request: { requestId: string } }).request
			.requestId;

		listeners.get("ai://response/failed")?.({
			payload: { requestId, error: "Provider unavailable" },
		});

		await expect(evaluation).rejects.toThrow("Provider unavailable");
		expect(unlisten).toHaveBeenCalledTimes(3);
	});

	test("rejects invoke errors and unlistens", async () => {
		const { backend, invoke, unlisten } = createBackend();
		invoke.mockRejectedValue(new Error("Invocation failed"));

		await expect(new BackendAiClient(backend).evaluate(prompt)).rejects.toThrow(
			"Invocation failed",
		);
		expect(unlisten).toHaveBeenCalledTimes(3);
	});
});
