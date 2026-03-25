import { Configuration } from './gen/configuration.js';
import { RequestContext } from './gen/http/http.js';
import { ApiException } from './api.js';
import { KubernetesObject } from './types.js';
import { Watchable } from './informer.js';
import { sendRawRequest, buildRequestContext, parseWatchStream, createHttpError } from './stream-utils.js';

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';

export interface WatchEvent<T extends KubernetesObject = KubernetesObject> {
    type: WatchEventType;
    object: T;
}

export class WatchApi implements Watchable {
    public static SERVER_SIDE_CLOSE: object = { error: 'Connection closed on server' };
    private readonly configuration: Configuration;
    private requestTimeoutMs: number = 30000;

    public constructor(configuration: Configuration) {
        this.configuration = configuration;
    }

    /**
     * Sets the request timeout in milliseconds.
     */
    public setRequestTimeout(timeout: number): void {
        this.requestTimeoutMs = timeout;
    }

    /**
     * Watch Kubernetes resources using an async iterator.
     *
     * Supports both streaming (via `response.body.stream()`) and text fallback
     * for custom HTTP libraries that may not support streaming.
     *
     * @example
     * ```typescript
     * const watchApi = kubeconfig.makeApiClient(WatchApi);
     * for await (const event of watchApi.watch<V1Pod>('/api/v1/namespaces/default/pods')) {
     *   console.log(`${event.type}: ${event.object.metadata?.name}`);
     * }
     * ```
     *
     * @example With query parameters:
     * ```typescript
     * for await (const event of watchApi.watch<V1Pod>('/api/v1/pods', {
     *   labelSelector: 'app=nginx',
     *   resourceVersion: '12345',
     * })) {
     *   console.log(event.type, event.object.metadata?.name);
     * }
     * ```
     */
    async *watchIter<T extends KubernetesObject>(
        path: string,
        queryParams: Record<string, string | number | boolean | undefined> = {},
    ): AsyncGenerator<WatchEvent<T>, void, undefined> {
        const requestContext = await buildRequestContext(this.configuration, path, {
            ...queryParams,
            watch: 'true',
        });

        const controller = new AbortController();
        const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
        requestContext.setSignal(AbortSignal.any([controller.signal, timeoutSignal]));

        try {
            const response = await sendRawRequest(this.configuration, requestContext);

            if (response.httpStatusCode !== 200) {
                const body = await response.body.text();
                throw new ApiException(
                    response.httpStatusCode,
                    'Watch request failed',
                    body,
                    response.headers,
                );
            }

            const stream = response.body.stream();
            if (stream) {
                // Use streaming if available
                for await (const event of parseWatchStream<T>(stream)) {
                    yield event as WatchEvent<T>;
                }
            } else {
                // Fallback: parse full text response line by line
                const text = await response.body.text();
                const lines = text.split('\n').filter((line) => line.trim() !== '');
                for (const line of lines) {
                    const data = JSON.parse(line) as WatchEvent<T>;
                    yield { type: data.type, object: data.object };
                }
            }
        } finally {
            controller.abort();
        }
    }

    /**
     * Watch a Kubernetes resource using a callback-based API.
     * Compatible with the Watchable interface used by Informer/ListWatch.
     *
     * Supports two overloads:
     * 1. Path-based: `watch(path, queryParams, callback, done)`
     * 2. RequestFactory-based: `watch(makeRequest, callback, done, options)`
     */
    public async watch<T>(
        makeRequest: (config: Configuration) => Promise<RequestContext>,
        callback: (phase: string, apiObj: T, watchObj?: any) => void,
        done: (err: any) => void,
        options?: { timeoutMs?: number },
    ): Promise<AbortController>;
    public async watch<T>(
        path: string,
        queryParams: Record<string, string | number | boolean | undefined>,
        callback: (phase: string, apiObj: T, watchObj?: any) => void,
        done: (err: any) => void,
        options?: { timeoutMs?: number },
    ): Promise<AbortController>;
    public async watch<T>(
        pathOrMakeRequest: string | ((config: Configuration) => Promise<RequestContext>),
        queryParamsOrCallback:
            | Record<string, string | number | boolean | undefined>
            | ((phase: string, apiObj: T, watchObj?: any) => void),
        callbackOrDone: ((phase: string, apiObj: T, watchObj?: any) => void) | ((err: any) => void),
        doneOrOptions?: ((err: any) => void) | { timeoutMs?: number },
        maybeOptions?: { timeoutMs?: number },
    ): Promise<AbortController> {
        let requestContext: RequestContext;
        let callback: (phase: string, apiObj: T, watchObj?: any) => void;
        let done: (err: any) => void;
        let options: { timeoutMs?: number } | undefined;

        if (typeof pathOrMakeRequest === 'string') {
            const queryParams = queryParamsOrCallback as Record<
                string,
                string | number | boolean | undefined
            >;
            callback = callbackOrDone as (phase: string, apiObj: T, watchObj?: any) => void;
            done = doneOrOptions as (err: any) => void;
            options = maybeOptions;

            requestContext = await buildRequestContext(this.configuration, pathOrMakeRequest, {
                ...queryParams,
                watch: 'true',
            });
        } else {
            callback = queryParamsOrCallback as (phase: string, apiObj: T, watchObj?: any) => void;
            done = callbackOrDone as (err: any) => void;
            options = doneOrOptions as { timeoutMs?: number } | undefined;

            requestContext = await pathOrMakeRequest(this.configuration);
        }

        const controller = new AbortController();
        const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
        const signals: AbortSignal[] = [controller.signal];
        if (timeoutMs > 0) {
            signals.push(AbortSignal.timeout(timeoutMs));
        }
        requestContext.setSignal(AbortSignal.any(signals));

        let doneCalled = false;
        const doneCallOnce = (err: any) => {
            if (!doneCalled) {
                doneCalled = true;
                controller.abort();
                done(err);
            }
        };

        try {
            const response = await sendRawRequest(this.configuration, requestContext);

            if (response.httpStatusCode !== 200) {
                throw createHttpError(response.httpStatusCode);
            }

            const stream = response.body.stream();
            if (stream) {
                this.consumeWebStream<T>(stream, callback, doneCallOnce);
            } else {
                // Text fallback
                const text = await response.body.text();
                const lines = text.split('\n').filter((line) => line.trim() !== '');
                for (const line of lines) {
                    try {
                        const data = JSON.parse(line);
                        callback(data.type, data.object, data);
                    } catch {
                        // ignore parse errors
                    }
                }
                doneCallOnce(null);
            }
        } catch (err) {
            doneCallOnce(err);
        }

        return controller;
    }

    private async consumeWebStream<T>(
        stream: ReadableStream<Uint8Array>,
        callback: (phase: string, apiObj: T, watchObj?: any) => void,
        done: (err: any) => void,
    ): Promise<void> {
        try {
            for await (const event of parseWatchStream<T>(stream)) {
                callback(event.type, event.object, event);
            }
            done(null);
        } catch (err) {
            done(err);
        }
    }
}
