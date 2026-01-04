import { STATUS_CODES } from 'node:http';
import { createInterface } from 'node:readline';
import fetch, { RequestInit as NodeFetchRequestInit, Response as NodeFetchResponse } from 'node-fetch';
import { KubernetesObject } from './types.js';
import { KubeConfig } from './config.js';
import { Configuration, ApiException } from './gen/index.js';

/**
 * Represents the type of watch event received from the Kubernetes API.
 *
 * - `ADDED`: A new object was added.
 * - `MODIFIED`: An existing object was modified.
 * - `DELETED`: An object was deleted.
 * - `BOOKMARK`: A bookmark event for efficient reconnection (contains only resourceVersion).
 * - `ERROR`: An error occurred during the watch.
 */
export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';

/**
 * Represents a single watch event from the Kubernetes API.
 *
 * @typeParam T - The Kubernetes object type (e.g., V1Pod, V1Deployment).
 *
 * @example
 * ```typescript
 * import { WatchEvent, V1Pod } from '@kubernetes/client-node';
 *
 * const event: WatchEvent<V1Pod> = {
 *   type: 'ADDED',
 *   object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'my-pod' } }
 * };
 * ```
 */
export interface WatchEvent<T extends KubernetesObject> {
    /**
     * The type of event that occurred.
     */
    type: WatchEventType;

    /**
     * The Kubernetes object associated with this event.
     * For ERROR events, this may contain error details rather than a standard K8s object.
     */
    object: T;
}

/**
 * A watch API implementation that uses async iterators and follows the generated
 * Kubernetes API client pattern. This allows users to use it with `makeApiClient`.
 *
 * The class uses streaming to read lines from the response body, similar to the
 * original `Watch` class, but provides an async iterator interface instead of callbacks.
 *
 * @example Using with makeApiClient:
 * ```typescript
 * import { KubeConfig, WatchApi, V1Pod } from '@kubernetes/client-node';
 *
 * const kubeConfig = new KubeConfig();
 * kubeConfig.loadFromDefault();
 *
 * const watchApi = kubeConfig.makeApiClient(WatchApi);
 *
 * for await (const event of watchApi.watch<V1Pod>('/api/v1/namespaces/default/pods')) {
 *   console.log(`${event.type}: ${event.object.metadata?.name}`);
 * }
 * ```
 *
 * @example With query parameters:
 * ```typescript
 * for await (const event of watchApi.watch<V1Pod>('/api/v1/namespaces/default/pods', {
 *   labelSelector: 'app=nginx',
 *   resourceVersion: '12345',
 *   allowWatchBookmarks: true,
 * })) {
 *   switch (event.type) {
 *     case 'ADDED':
 *       console.log('Pod added:', event.object.metadata?.name);
 *       break;
 *     case 'MODIFIED':
 *       console.log('Pod modified:', event.object.metadata?.name);
 *       break;
 *     case 'DELETED':
 *       console.log('Pod deleted:', event.object.metadata?.name);
 *       break;
 *   }
 * }
 * ```
 */
export class WatchApi {
    private configuration: Configuration;
    private requestTimeoutMs: number = 30000;

    /**
     * Creates a new WatchApi instance.
     *
     * @param configuration - The API configuration object from `createConfiguration()` or via `makeApiClient`.
     */
    constructor(configuration: Configuration) {
        this.configuration = configuration;
    }

    /**
     * Sets the request timeout in milliseconds.
     *
     * @param timeout - Timeout in milliseconds.
     */
    public setRequestTimeout(timeout: number): void {
        this.requestTimeoutMs = timeout;
    }

    /**
     * Watches for changes to Kubernetes resources at the specified path.
     * Returns an async iterator that yields watch events.
     *
     * Uses streaming to read lines from the response body, avoiding loading the entire
     * response into memory.
     *
     * @typeParam T - The Kubernetes object type to expect (e.g., V1Pod, V1Deployment).
     *
     * @param path - The API path to watch (e.g., '/api/v1/namespaces/default/pods').
     * @param queryParams - Optional query parameters for the watch request.
     *                      Supports any query parameter accepted by the Kubernetes API.
     *
     * @yields {WatchEvent<T>} Events as they are received from the API server.
     *
     * @throws {ApiException} When the watch request fails or the server returns an error status.
     *
     * @example
     * ```typescript
     * for await (const event of watchApi.watch<V1Pod>('/api/v1/namespaces/default/pods', {
     *   labelSelector: 'app=nginx',
     *   resourceVersion: '12345',
     * })) {
     *   console.log(`${event.type}: ${event.object.metadata?.name}`);
     * }
     * ```
     */
    async *watch<T extends KubernetesObject>(
        path: string,
        queryParams: Record<string, string | number | boolean | undefined> = {},
    ): AsyncGenerator<WatchEvent<T>, void, undefined> {
        // Get the KubeConfig from the auth methods to access server URL and apply auth
        const authMethod = this.configuration.authMethods.default;
        if (!authMethod || !('getCurrentCluster' in authMethod)) {
            throw new ApiException(500, 'WatchApi requires KubeConfig as the authentication method', '', {});
        }

        const kubeConfig = authMethod as KubeConfig;
        const cluster = kubeConfig.getCurrentCluster();
        if (!cluster) {
            throw new ApiException(500, 'No active cluster', '', {});
        }

        const watchURL = new URL(cluster.server + path);
        watchURL.searchParams.set('watch', 'true');

        for (const [key, val] of Object.entries(queryParams)) {
            if (val !== undefined) {
                watchURL.searchParams.set(key, val.toString());
            }
        }

        const requestInit: NodeFetchRequestInit = await kubeConfig.applyToFetchOptions({});

        const controller = new AbortController();
        const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
        requestInit.signal = AbortSignal.any([controller.signal, timeoutSignal]);
        requestInit.method = 'GET';

        let response: NodeFetchResponse;
        try {
            response = await fetch(watchURL, requestInit);

            if (requestInit.agent && typeof requestInit.agent === 'object') {
                const agent = requestInit.agent as { sockets?: Record<string, unknown[]> };
                if (agent.sockets) {
                    for (const socket of Object.values(agent.sockets).flat()) {
                        const sock = socket as {
                            setKeepAlive?: (enable: boolean, initialDelay: number) => void;
                        };
                        sock?.setKeepAlive?.(true, 30000);
                    }
                }
            }

            if (response.status !== 200) {
                const statusText =
                    response.statusText || STATUS_CODES[response.status] || 'Internal Server Error';
                const body = await response.text();
                throw new ApiException(response.status, statusText, body, {});
            }

            const body = response.body!;

            // Create an async iterator from the readline interface
            const lines = createInterface(body);

            for await (const line of lines) {
                try {
                    const data = JSON.parse(line.toString()) as { type: WatchEventType; object: T };
                    yield {
                        type: data.type,
                        object: data.object,
                    };
                } catch {
                    // ignore parse errors
                }
            }
        } finally {
            controller.abort();
        }
    }
}
