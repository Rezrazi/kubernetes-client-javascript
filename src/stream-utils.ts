import { STATUS_CODES } from 'node:http';
import { Configuration } from './gen/configuration.js';
import { RequestContext, ResponseContext, HttpMethod } from './gen/http/http.js';

/**
 * Sends a request through the Configuration middleware pipeline and returns
 * the raw ResponseContext without deserializing the body.
 *
 * This is used by WatchApi and LogApi to access the response stream directly.
 */
export async function sendRawRequest(
    configuration: Configuration,
    requestContext: RequestContext,
    signal?: AbortSignal,
): Promise<ResponseContext> {
    if (signal) {
        requestContext.setSignal(signal);
    }

    // Pre-middleware (forward order)
    let ctx: RequestContext = requestContext;
    for (const middleware of [...configuration.middleware]) {
        ctx = await middleware.pre(ctx).toPromise();
    }

    // Send request
    const response = await configuration.httpApi.send(ctx).toPromise();

    // Post-middleware (reverse order, clone to avoid mutation)
    let rsp: ResponseContext = response;
    for (const middleware of [...configuration.middleware].reverse()) {
        rsp = await middleware.post(rsp).toPromise();
    }

    return rsp;
}

/**
 * Builds a RequestContext for a given path and query params using the Configuration's
 * base server and auth methods. Used by the path-based watch/log overloads.
 */
export async function buildRequestContext(
    configuration: Configuration,
    path: string,
    queryParams?: Record<string, string | number | boolean | undefined>,
): Promise<RequestContext> {
    const requestContext = configuration.baseServer.makeRequestContext(path, HttpMethod.GET);
    requestContext.setHeaderParam('Accept', 'application/json, */*;q=0.8');

    if (queryParams) {
        for (const [key, val] of Object.entries(queryParams)) {
            if (val !== undefined) {
                requestContext.setQueryParam(key, String(val));
            }
        }
    }

    // Apply auth
    const authMethod = configuration.authMethods['default'] || configuration.authMethods['BearerToken'];
    if (authMethod) {
        await authMethod.applySecurityAuthentication(requestContext);
    }

    return requestContext;
}

/**
 * Parses a ReadableStream of newline-delimited JSON into watch events.
 * Handles partial lines that span chunk boundaries.
 * Each yielded object has `{ type, object }` shape matching Kubernetes watch events.
 */
export async function* parseWatchStream<T = any>(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; object: T }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                // Process any remaining buffered data
                if (buffer.trim()) {
                    try {
                        yield JSON.parse(buffer) as { type: string; object: T };
                    } catch {
                        // ignore parse errors on final incomplete line
                    }
                }
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            // Last element may be incomplete — keep it in buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    yield JSON.parse(trimmed) as { type: string; object: T };
                } catch {
                    // ignore parse errors
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Creates an error from a non-200 response status code.
 */
export function createHttpError(statusCode: number): Error & { statusCode: number } {
    const statusText = STATUS_CODES[statusCode] || 'Unknown Error';
    const error = new Error(statusText) as Error & { statusCode: number };
    error.statusCode = statusCode;
    return error;
}
