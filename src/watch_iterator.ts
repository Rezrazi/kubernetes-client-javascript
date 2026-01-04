import { STATUS_CODES } from 'node:http';
import { KubernetesObject } from './types.js';
import {
    Configuration,
    createConfiguration,
    HttpMethod,
    ResponseContext,
    ServerConfiguration,
    SecurityAuthentication,
} from './gen/index.js';

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
 * Options for configuring watch requests.
 */
export interface WatchOptions {
    /**
     * Resource version to start watching from.
     * If not specified, the watch starts from the most recent version.
     */
    resourceVersion?: string;

    /**
     * Label selector to filter objects.
     * @example 'app=nginx,env=production'
     */
    labelSelector?: string;

    /**
     * Field selector to filter objects.
     * @example 'metadata.name=my-pod'
     */
    fieldSelector?: string;

    /**
     * Timeout in milliseconds for the watch request.
     * @default 30000
     */
    timeoutMs?: number;

    /**
     * Allow watch bookmarks to be sent.
     * @default true
     */
    allowWatchBookmarks?: boolean;
}

/**
 * Error thrown when a watch request fails.
 */
export class WatchError extends Error {
    /**
     * HTTP status code from the failed request, if available.
     */
    public readonly statusCode?: number;

    /**
     * Creates a new WatchError.
     *
     * @param message - Error message.
     * @param statusCode - HTTP status code, if available.
     */
    constructor(message: string, statusCode?: number) {
        super(message);
        this.name = 'WatchError';
        this.statusCode = statusCode;
    }
}

/**
 * A watch implementation that uses async iterators and the Configuration pattern
 * from the generated Kubernetes API client. This allows users to provide custom
 * HTTP implementations via `wrapHttpLibrary` and `createConfiguration`.
 *
 * @example Basic usage with default configuration:
 * ```typescript
 * import { KubeConfig, WatchIterator, V1Pod, createConfiguration, ServerConfiguration } from '@kubernetes/client-node';
 *
 * const kubeConfig = new KubeConfig();
 * kubeConfig.loadFromDefault();
 *
 * const configuration = createConfiguration({
 *   baseServer: new ServerConfiguration(kubeConfig.getCurrentCluster()!.server, {}),
 *   authMethods: { default: kubeConfig },
 * });
 *
 * const watch = new WatchIterator(configuration);
 *
 * for await (const event of watch.watch<V1Pod>('/api/v1/namespaces/default/pods')) {
 *   console.log(`${event.type}: ${event.object.metadata?.name}`);
 * }
 * ```
 *
 * @example Using a custom HTTP library (e.g., with Bun/ky):
 * ```typescript
 * import { KubeConfig, WatchIterator, V1Pod, wrapHttpLibrary, createConfiguration, ServerConfiguration, ResponseContext } from '@kubernetes/client-node';
 * import ky from 'ky';
 *
 * const httpApi = wrapHttpLibrary({
 *   async send(request) {
 *     const response = await ky(request.getUrl(), {
 *       method: request.getHttpMethod(),
 *       headers: request.getHeaders(),
 *       body: request.getBody(),
 *     });
 *
 *     return new ResponseContext(
 *       response.status,
 *       Object.fromEntries(response.headers.entries()),
 *       {
 *         text: () => response.text(),
 *         binary: async () => Buffer.from(await response.arrayBuffer()),
 *       },
 *     );
 *   },
 * });
 *
 * const kubeConfig = new KubeConfig();
 * kubeConfig.loadFromDefault();
 *
 * const configuration = createConfiguration({
 *   baseServer: new ServerConfiguration(kubeConfig.getCurrentCluster()!.server, {}),
 *   authMethods: { default: kubeConfig },
 *   httpApi,
 * });
 *
 * const watch = new WatchIterator(configuration);
 *
 * for await (const event of watch.watch<V1Pod>('/api/v1/namespaces/default/pods')) {
 *   console.log(`${event.type}: ${event.object.metadata?.name}`);
 * }
 * ```
 */
export class WatchIterator {
    private readonly configuration: Configuration;

    /**
     * Creates a new WatchIterator instance.
     *
     * @param configuration - The API configuration object. Create using `createConfiguration()`.
     */
    constructor(configuration: Configuration) {
        this.configuration = configuration;
    }

    /**
     * Watches for changes to Kubernetes resources at the specified path.
     * Returns an async iterator that yields watch events.
     *
     * @typeParam T - The Kubernetes object type to expect (e.g., V1Pod, V1Deployment).
     *
     * @param path - The API path to watch (e.g., '/api/v1/namespaces/default/pods').
     * @param options - Optional configuration for the watch request.
     *
     * @yields {WatchEvent<T>} Events as they are received from the API server.
     *
     * @throws {WatchError} When the watch request fails or the server returns an error status.
     *
     * @example
     * ```typescript
     * const watch = new WatchIterator(configuration);
     *
     * for await (const event of watch.watch<V1Pod>('/api/v1/namespaces/default/pods', {
     *   labelSelector: 'app=nginx',
     *   resourceVersion: '12345',
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
    async *watch<T extends KubernetesObject>(
        path: string,
        options: WatchOptions = {},
    ): AsyncGenerator<WatchEvent<T>, void, undefined> {
        const {
            resourceVersion,
            labelSelector,
            fieldSelector,
            timeoutMs = 30000,
            allowWatchBookmarks = true,
        } = options;

        // Build the request context
        const requestContext = this.configuration.baseServer.makeRequestContext(path, HttpMethod.GET);
        requestContext.setQueryParam('watch', 'true');

        if (resourceVersion !== undefined) {
            requestContext.setQueryParam('resourceVersion', resourceVersion);
        }
        if (labelSelector !== undefined) {
            requestContext.setQueryParam('labelSelector', labelSelector);
        }
        if (fieldSelector !== undefined) {
            requestContext.setQueryParam('fieldSelector', fieldSelector);
        }
        if (allowWatchBookmarks) {
            requestContext.setQueryParam('allowWatchBookmarks', 'true');
        }

        // Apply authentication if configured
        if (this.configuration.authMethods.default) {
            await this.configuration.authMethods.default.applySecurityAuthentication(requestContext);
        }

        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        requestContext.setSignal(AbortSignal.any([controller.signal, timeoutSignal]));

        // Send request through the HTTP library
        const observable = this.configuration.httpApi.send(requestContext);
        let response: ResponseContext;
        try {
            response = await observable.toPromise();
        } catch (error) {
            if (error instanceof Error) {
                throw new WatchError(error.message);
            }
            throw new WatchError('Failed to connect to watch endpoint');
        }

        if (response.httpStatusCode !== 200) {
            const statusText = STATUS_CODES[response.httpStatusCode] || 'Unknown Error';
            throw new WatchError(statusText, response.httpStatusCode);
        }

        // Get the response body text and parse line by line
        // Note: The standard Configuration/HttpLibrary pattern doesn't support streaming natively,
        // so we read the full response and parse it. For true streaming with custom HTTP libraries,
        // users should implement streaming in their custom httpApi.
        const bodyText = await response.body.text();

        // Parse JSON lines
        const lines = bodyText.split('\n').filter((line) => line.trim() !== '');

        for (const line of lines) {
            try {
                const data = JSON.parse(line) as { type: WatchEventType; object: T };
                yield {
                    type: data.type,
                    object: data.object,
                };
            } catch {
                // Skip lines that fail to parse
            }
        }
    }
}

/**
 * Creates a new WatchIterator with a simple KubeConfig-based configuration.
 *
 * This is a convenience function that creates a WatchIterator using the default
 * HTTP library. For custom HTTP implementations, use `createConfiguration` and
 * `wrapHttpLibrary` directly.
 *
 * @param kubeConfig - The KubeConfig to use for authentication and server discovery.
 *
 * @returns A configured WatchIterator instance.
 *
 * @throws {Error} If no current cluster is configured in the KubeConfig.
 *
 * @example
 * ```typescript
 * import { KubeConfig, createWatchIterator, V1Pod } from '@kubernetes/client-node';
 *
 * const kubeConfig = new KubeConfig();
 * kubeConfig.loadFromDefault();
 *
 * const watch = createWatchIterator(kubeConfig);
 *
 * for await (const event of watch.watch<V1Pod>('/api/v1/namespaces/default/pods')) {
 *   console.log(`${event.type}: ${event.object.metadata?.name}`);
 * }
 * ```
 */
export function createWatchIterator(
    kubeConfig: SecurityAuthentication & {
        getCurrentCluster(): { server: string } | null;
    },
): WatchIterator {
    const cluster = kubeConfig.getCurrentCluster();
    if (!cluster) {
        throw new Error('No currently active cluster');
    }

    const configuration = createConfiguration({
        baseServer: new ServerConfiguration(cluster.server, {}),
        authMethods: { default: kubeConfig },
    });

    return new WatchIterator(configuration);
}
