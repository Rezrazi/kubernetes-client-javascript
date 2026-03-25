import { Readable } from 'node:stream';
import { Writable } from 'node:stream';
import { Configuration } from './gen/configuration.js';
import { RequestContext } from './gen/http/http.js';
import { ApiException } from './api.js';
import { V1Status } from './gen/index.js';
import { sendRawRequest, buildRequestContext } from './stream-utils.js';

import type { LogOptions } from './log.js';

export class LogApi {
    private readonly configuration: Configuration;

    public constructor(configuration: Configuration) {
        this.configuration = configuration;
    }

    /**
     * Stream logs from a pod container.
     *
     * @param namespace - Pod namespace
     * @param podName - Pod name
     * @param containerName - Container name
     * @param stream - Writable stream to pipe logs to
     * @param options - Log options (follow, tailLines, etc.)
     */
    public async log(
        namespace: string,
        podName: string,
        containerName: string,
        stream: Writable,
        options?: LogOptions,
    ): Promise<AbortController>;

    /**
     * Stream logs from a pod using a generated RequestFactory method.
     *
     * @param makeRequest - Function that builds a RequestContext via a generated RequestFactory
     * @param stream - Writable stream to pipe logs to
     */
    public async log(
        makeRequest: (config: Configuration) => Promise<RequestContext>,
        stream: Writable,
    ): Promise<AbortController>;

    public async log(
        namespaceOrMakeRequest: string | ((config: Configuration) => Promise<RequestContext>),
        podNameOrStream: string | Writable,
        containerName?: string,
        stream?: Writable,
        options?: LogOptions,
    ): Promise<AbortController> {
        let requestContext: RequestContext;
        let outputStream: Writable;

        if (typeof namespaceOrMakeRequest === 'function') {
            // Function-based overload
            requestContext = await namespaceOrMakeRequest(this.configuration);
            outputStream = podNameOrStream as Writable;
        } else {
            // Path-based overload
            const namespace = namespaceOrMakeRequest;
            const podName = podNameOrStream as string;
            outputStream = stream!;

            const queryParams: Record<string, string | number | boolean | undefined> = {
                container: containerName,
            };
            if (options) {
                if (options.follow !== undefined) queryParams.follow = options.follow;
                if (options.limitBytes !== undefined) queryParams.limitBytes = options.limitBytes;
                if (options.pretty !== undefined) queryParams.pretty = options.pretty;
                if (options.previous !== undefined) queryParams.previous = options.previous;
                if (options.sinceSeconds !== undefined) queryParams.sinceSeconds = options.sinceSeconds;
                if (options.sinceTime !== undefined) queryParams.sinceTime = options.sinceTime;
                if (options.tailLines !== undefined) queryParams.tailLines = options.tailLines;
                if (options.timestamps !== undefined) queryParams.timestamps = options.timestamps;
            }

            const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/log`;
            requestContext = await buildRequestContext(this.configuration, path, queryParams);
        }

        const controller = new AbortController();
        requestContext.setSignal(controller.signal);

        try {
            const response = await sendRawRequest(this.configuration, requestContext);

            if (response.httpStatusCode === 200) {
                const bodyStream = response.body.stream();
                if (bodyStream) {
                    const nodeStream = Readable.fromWeb(bodyStream as any);
                    nodeStream.pipe(outputStream);
                }
            } else if (response.httpStatusCode === 500) {
                try {
                    const bodyText = await response.body.text();
                    const v1status = JSON.parse(bodyText) as V1Status;
                    if (v1status.code !== undefined && v1status.message !== undefined) {
                        throw new ApiException<V1Status>(
                            v1status.code,
                            v1status.message,
                            v1status,
                            response.headers,
                        );
                    }
                } catch (err) {
                    if (err instanceof ApiException) {
                        throw err;
                    }
                }
                throw new ApiException<undefined>(
                    response.httpStatusCode,
                    'Error occurred in log request',
                    undefined,
                    response.headers,
                );
            } else {
                throw new ApiException<undefined>(
                    response.httpStatusCode,
                    'Error occurred in log request',
                    undefined,
                    response.headers,
                );
            }
        } catch (err: any) {
            if (err instanceof ApiException) {
                throw err;
            }
            throw new ApiException<undefined>(500, 'Error occurred in log request', undefined, {});
        }

        return controller;
    }
}
