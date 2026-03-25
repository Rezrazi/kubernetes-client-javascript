import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, rejects } from 'node:assert';
import { WatchApi, WatchEvent } from './watch-api.js';
import {
    ApiException,
    createConfiguration,
    wrapHttpLibrary,
    ServerConfiguration,
    ResponseContext,
    RequestContext,
} from './gen/index.js';

const server = 'https://foo.company.com';

function createMockAuth() {
    return {
        getName: () => 'mock',
        applySecurityAuthentication: async (_context: RequestContext): Promise<void> => {},
    };
}

/**
 * Creates a mock configuration with a custom HTTP library for testing.
 */
function createMockConfiguration(
    baseUrl: string,
    responseBody: string,
    statusCode: number = 200,
    useStreaming: boolean = true,
) {
    const httpApi = wrapHttpLibrary({
        async send(_request: RequestContext): Promise<ResponseContext> {
            const body = useStreaming
                ? {
                      text: () => Promise.resolve(responseBody),
                      binary: () => Promise.resolve(Buffer.from(responseBody)),
                      stream: () =>
                          new ReadableStream({
                              start(controller) {
                                  controller.enqueue(new TextEncoder().encode(responseBody));
                                  controller.close();
                              },
                          }),
                  }
                : {
                      text: () => Promise.resolve(responseBody),
                      binary: () => Promise.resolve(Buffer.from(responseBody)),
                      stream: () => null,
                  };

            return new ResponseContext(statusCode, {}, body);
        },
    });

    return createConfiguration({
        baseServer: new ServerConfiguration(baseUrl, {}),
        authMethods: { default: createMockAuth() },
        httpApi,
    });
}

describe('WatchApi', () => {
    it('should construct correctly', () => {
        const config = createMockConfiguration(server, '');
        const watchApi = new WatchApi(config);
        strictEqual(watchApi instanceof WatchApi, true);
    });

    describe('watchIter (async iterator)', () => {
        it('should iterate over watch events using streaming', async () => {
            const events = [
                { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
                {
                    type: 'MODIFIED',
                    object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
                },
                {
                    type: 'DELETED',
                    object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
                },
            ];

            const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
            const config = createMockConfiguration(server, responseBody);
            const watchApi = new WatchApi(config);

            const receivedEvents: WatchEvent[] = [];
            for await (const event of watchApi.watchIter('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 3);
            deepStrictEqual(receivedEvents[0].type, 'ADDED');
            deepStrictEqual(receivedEvents[1].type, 'MODIFIED');
            deepStrictEqual(receivedEvents[2].type, 'DELETED');
            deepStrictEqual(receivedEvents[0].object.metadata?.name, 'pod1');
        });

        it('should iterate over watch events using text fallback', async () => {
            const events = [
                { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
                {
                    type: 'MODIFIED',
                    object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
                },
            ];

            const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
            const config = createMockConfiguration(server, responseBody, 200, false);
            const watchApi = new WatchApi(config);

            const receivedEvents: WatchEvent[] = [];
            for await (const event of watchApi.watchIter('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 2);
            deepStrictEqual(receivedEvents[0].type, 'ADDED');
            deepStrictEqual(receivedEvents[1].type, 'MODIFIED');
        });

        it('should handle BOOKMARK events', async () => {
            const events = [
                { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
                {
                    type: 'BOOKMARK',
                    object: {
                        apiVersion: 'v1',
                        kind: 'Pod',
                        metadata: { resourceVersion: '12345' },
                    },
                },
            ];

            const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
            const config = createMockConfiguration(server, responseBody);
            const watchApi = new WatchApi(config);

            const receivedEvents: WatchEvent[] = [];
            for await (const event of watchApi.watchIter('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 2);
            deepStrictEqual(receivedEvents[1].type, 'BOOKMARK');
        });

        it('should handle ERROR events in the watch stream', async () => {
            const events = [
                { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
                { type: 'ERROR', object: { code: 410, message: 'Gone', reason: 'Expired' } },
            ];

            const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
            const config = createMockConfiguration(server, responseBody);
            const watchApi = new WatchApi(config);

            const receivedEvents: WatchEvent[] = [];
            for await (const event of watchApi.watchIter('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 2);
            deepStrictEqual(receivedEvents[1].type, 'ERROR');
        });

        it('should throw ApiException on non-200 status', async () => {
            const config = createMockConfiguration(server, 'Internal Server Error', 500);
            const watchApi = new WatchApi(config);

            await rejects(
                async () => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for await (const _event of watchApi.watchIter('/api/v1/namespaces/default/pods')) {
                        // Should not reach here
                    }
                },
                (err: Error) => {
                    strictEqual(err instanceof ApiException, true);
                    strictEqual((err as ApiException<unknown>).code, 500);
                    return true;
                },
            );
        });

        it('should handle empty response', async () => {
            const config = createMockConfiguration(server, '');
            const watchApi = new WatchApi(config);

            const receivedEvents: WatchEvent[] = [];
            for await (const event of watchApi.watchIter('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 0);
        });

        it('should pass query parameters correctly', async () => {
            let capturedUrl: string = '';

            const httpApi = wrapHttpLibrary({
                async send(request: RequestContext): Promise<ResponseContext> {
                    capturedUrl = request.getUrl();
                    const event = {
                        type: 'ADDED',
                        object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
                    };
                    return new ResponseContext(
                        200,
                        {},
                        {
                            text: () => Promise.resolve(JSON.stringify(event)),
                            binary: () => Promise.resolve(Buffer.from(JSON.stringify(event))),
                            stream: () => null,
                        },
                    );
                },
            });

            const config = createConfiguration({
                baseServer: new ServerConfiguration(server, {}),
                authMethods: { default: createMockAuth() },
                httpApi,
            });

            const watchApi = new WatchApi(config);

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _event of watchApi.watchIter('/api/v1/namespaces/default/pods', {
                resourceVersion: '12345',
                labelSelector: 'app=nginx',
                allowWatchBookmarks: true,
            })) {
                // consume
            }

            strictEqual(capturedUrl.includes('watch=true'), true);
            strictEqual(capturedUrl.includes('resourceVersion=12345'), true);
            strictEqual(capturedUrl.includes('labelSelector=app%3Dnginx'), true);
            strictEqual(capturedUrl.includes('allowWatchBookmarks=true'), true);
        });
    });

    describe('watch (callback-based)', () => {
        it('should call callback for each event and done when stream ends', async () => {
            const events = [
                { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
                {
                    type: 'MODIFIED',
                    object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
                },
            ];

            const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
            const config = createMockConfiguration(server, responseBody);
            const watchApi = new WatchApi(config);

            const receivedEvents: Array<{ phase: string; obj: any }> = [];
            const donePromise = new Promise<any>((resolve) => {
                watchApi.watch(
                    '/api/v1/namespaces/default/pods',
                    {},
                    (phase, obj) => {
                        receivedEvents.push({ phase, obj });
                    },
                    (err) => {
                        resolve(err);
                    },
                );
            });

            const doneErr = await donePromise;
            strictEqual(doneErr, null);
            strictEqual(receivedEvents.length, 2);
            deepStrictEqual(receivedEvents[0].phase, 'ADDED');
            deepStrictEqual(receivedEvents[1].phase, 'MODIFIED');
        });

        it('should call done with error on non-200 status', async () => {
            const config = createMockConfiguration(server, 'error', 500);
            const watchApi = new WatchApi(config);

            const donePromise = new Promise<any>((resolve) => {
                watchApi.watch(
                    '/api/v1/namespaces/default/pods',
                    {},
                    () => {},
                    (err) => {
                        resolve(err);
                    },
                );
            });

            const doneErr = await donePromise;
            strictEqual(doneErr != null, true);
            strictEqual(doneErr.statusCode, 500);
        });

        it('should work with text fallback when stream is null', async () => {
            const events = [
                { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
            ];

            const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
            const config = createMockConfiguration(server, responseBody, 200, false);
            const watchApi = new WatchApi(config);

            const receivedEvents: Array<{ phase: string; obj: any }> = [];
            const donePromise = new Promise<any>((resolve) => {
                watchApi.watch(
                    '/api/v1/namespaces/default/pods',
                    {},
                    (phase, obj) => {
                        receivedEvents.push({ phase, obj });
                    },
                    (err) => {
                        resolve(err);
                    },
                );
            });

            const doneErr = await donePromise;
            strictEqual(doneErr, null);
            strictEqual(receivedEvents.length, 1);
            deepStrictEqual(receivedEvents[0].phase, 'ADDED');
        });

        it('should return AbortController that can cancel the watch', async () => {
            const config = createMockConfiguration(server, '');
            const watchApi = new WatchApi(config);

            const controller = await watchApi.watch(
                '/api/v1/namespaces/default/pods',
                {},
                () => {},
                () => {},
            );

            strictEqual(controller instanceof AbortController, true);
            controller.abort();
            strictEqual(controller.signal.aborted, true);
        });
    });

    describe('middleware execution', () => {
        it('should run pre and post middleware', async () => {
            const middlewareCalls: string[] = [];

            const httpApi = wrapHttpLibrary({
                async send(_request: RequestContext): Promise<ResponseContext> {
                    const event = {
                        type: 'ADDED',
                        object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
                    };
                    return new ResponseContext(
                        200,
                        {},
                        {
                            text: () => Promise.resolve(JSON.stringify(event)),
                            binary: () => Promise.resolve(Buffer.from(JSON.stringify(event))),
                            stream: () => null,
                        },
                    );
                },
            });

            const config = createConfiguration({
                baseServer: new ServerConfiguration(server, {}),
                authMethods: { default: createMockAuth() },
                httpApi,
                promiseMiddleware: [
                    {
                        async pre(context) {
                            middlewareCalls.push('pre');
                            return context;
                        },
                        async post(context) {
                            middlewareCalls.push('post');
                            return context;
                        },
                    },
                ],
            });

            const watchApi = new WatchApi(config);

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _event of watchApi.watchIter('/api/v1/namespaces/default/pods')) {
                // consume
            }

            strictEqual(middlewareCalls.includes('pre'), true);
            strictEqual(middlewareCalls.includes('post'), true);
        });
    });

    describe('custom HTTP library', () => {
        it('should work with custom HTTP implementation', async () => {
            const events = [
                {
                    type: 'ADDED',
                    object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'custom-pod' } },
                },
            ];
            const responseBody = events.map((e) => JSON.stringify(e)).join('\n');

            const customHttpApi = wrapHttpLibrary({
                async send(request: RequestContext): Promise<ResponseContext> {
                    strictEqual(request.getHttpMethod(), 'GET');
                    strictEqual(request.getUrl().includes('/api/v1/namespaces/default/pods'), true);

                    return new ResponseContext(
                        200,
                        { 'content-type': 'application/json' },
                        {
                            text: () => Promise.resolve(responseBody),
                            binary: () => Promise.resolve(Buffer.from(responseBody)),
                            stream: () =>
                                new ReadableStream({
                                    start(controller) {
                                        controller.enqueue(new TextEncoder().encode(responseBody));
                                        controller.close();
                                    },
                                }),
                        },
                    );
                },
            });

            const configuration = createConfiguration({
                baseServer: new ServerConfiguration(server, {}),
                authMethods: { default: createMockAuth() },
                httpApi: customHttpApi,
            });

            const watchApi = new WatchApi(configuration);

            const receivedEvents: WatchEvent[] = [];
            for await (const event of watchApi.watchIter('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 1);
            deepStrictEqual(receivedEvents[0].object.metadata?.name, 'custom-pod');
        });
    });
});
