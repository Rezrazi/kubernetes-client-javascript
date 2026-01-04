import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, rejects } from 'node:assert';
import { KubeConfig } from './config.js';
import { Cluster, Context, User } from './config_types.js';
import { WatchIterator, WatchEvent, WatchError, createWatchIterator } from './watch_iterator.js';
import {
    Configuration,
    createConfiguration,
    ServerConfiguration,
    wrapHttpLibrary,
    ResponseContext,
    RequestContext,
} from './gen/index.js';

const server = 'https://foo.company.com';

const fakeConfig: {
    clusters: Cluster[];
    contexts: Context[];
    users: User[];
} = {
    clusters: [
        {
            name: 'cluster',
            server,
        } as Cluster,
    ],
    contexts: [
        {
            cluster: 'cluster',
            user: 'user',
        } as Context,
    ],
    users: [
        {
            name: 'user',
        } as User,
    ],
};

/**
 * Creates a mock configuration with a custom HTTP library for testing.
 */
function createMockConfiguration(
    baseUrl: string,
    responseBody: string,
    statusCode: number = 200,
): Configuration {
    const httpApi = wrapHttpLibrary({
        async send(_request: RequestContext): Promise<ResponseContext> {
            return new ResponseContext(
                statusCode,
                {},
                {
                    text: () => Promise.resolve(responseBody),
                    binary: () => Promise.resolve(Buffer.from(responseBody)),
                },
            );
        },
    });

    // Create a mock auth method that does nothing
    const mockAuth = {
        getName: () => 'mock',
        applySecurityAuthentication: async (_context: RequestContext): Promise<void> => {},
    };

    return createConfiguration({
        baseServer: new ServerConfiguration(baseUrl, {}),
        authMethods: { default: mockAuth },
        httpApi,
    });
}

describe('WatchIterator', () => {
    it('should construct correctly', () => {
        const kc = new KubeConfig();
        Object.assign(kc, fakeConfig);
        const config = createConfiguration({
            baseServer: new ServerConfiguration(server, {}),
            authMethods: { default: kc },
        });
        new WatchIterator(config);
    });

    it('should iterate over watch events', async () => {
        const events = [
            { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
            { type: 'MODIFIED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
            { type: 'DELETED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
        ];

        const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
        const config = createMockConfiguration(server, responseBody);
        const watch = new WatchIterator(config);

        const receivedEvents: WatchEvent<any>[] = [];
        for await (const event of watch.watch('/api/v1/namespaces/default/pods')) {
            receivedEvents.push(event);
        }

        strictEqual(receivedEvents.length, 3);
        deepStrictEqual(receivedEvents[0].type, 'ADDED');
        deepStrictEqual(receivedEvents[1].type, 'MODIFIED');
        deepStrictEqual(receivedEvents[2].type, 'DELETED');
        deepStrictEqual(receivedEvents[0].object.metadata?.name, 'pod1');
    });

    it('should handle BOOKMARK events', async () => {
        const events = [
            { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
            {
                type: 'BOOKMARK',
                object: { apiVersion: 'v1', kind: 'Pod', metadata: { resourceVersion: '12345' } },
            },
        ];

        const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
        const config = createMockConfiguration(server, responseBody);
        const watch = new WatchIterator(config);

        const receivedEvents: WatchEvent<any>[] = [];
        for await (const event of watch.watch('/api/v1/namespaces/default/pods')) {
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
        const watch = new WatchIterator(config);

        const receivedEvents: WatchEvent<any>[] = [];
        for await (const event of watch.watch('/api/v1/namespaces/default/pods')) {
            receivedEvents.push(event);
        }

        strictEqual(receivedEvents.length, 2);
        deepStrictEqual(receivedEvents[1].type, 'ERROR');
        deepStrictEqual(receivedEvents[1].object.code, 410);
    });

    it('should throw WatchError on non-200 status', async () => {
        const config = createMockConfiguration(server, 'Internal Server Error', 500);
        const watch = new WatchIterator(config);

        await rejects(
            async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                for await (const event of watch.watch('/api/v1/namespaces/default/pods')) {
                    // Should not reach here
                }
            },
            (err: Error) => {
                strictEqual(err instanceof WatchError, true);
                strictEqual((err as WatchError).statusCode, 500);
                return true;
            },
        );
    });

    it('should skip invalid JSON lines', async () => {
        const validEvent = {
            type: 'ADDED',
            object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
        };
        const responseBody = `${JSON.stringify(validEvent)}\n{"invalid json\n${JSON.stringify(validEvent)}`;
        const config = createMockConfiguration(server, responseBody);
        const watch = new WatchIterator(config);

        const receivedEvents: WatchEvent<any>[] = [];
        for await (const event of watch.watch('/api/v1/namespaces/default/pods')) {
            receivedEvents.push(event);
        }

        // Should only receive 2 valid events, skipping the invalid JSON line
        strictEqual(receivedEvents.length, 2);
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
                    },
                );
            },
        });

        const mockAuth = {
            getName: () => 'mock',
            applySecurityAuthentication: async (_context: RequestContext): Promise<void> => {},
        };

        const config = createConfiguration({
            baseServer: new ServerConfiguration(server, {}),
            authMethods: { default: mockAuth },
            httpApi,
        });

        const watch = new WatchIterator(config);

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const event of watch.watch('/api/v1/namespaces/default/pods', {
            resourceVersion: '12345',
            labelSelector: 'app=nginx',
            fieldSelector: 'metadata.name=my-pod',
        })) {
            // Just consume the event
        }

        strictEqual(capturedUrl.includes('watch=true'), true);
        strictEqual(capturedUrl.includes('resourceVersion=12345'), true);
        strictEqual(capturedUrl.includes('labelSelector=app%3Dnginx'), true);
        strictEqual(capturedUrl.includes('fieldSelector=metadata.name%3Dmy-pod'), true);
        strictEqual(capturedUrl.includes('allowWatchBookmarks=true'), true);
    });

    it('should handle empty response', async () => {
        const config = createMockConfiguration(server, '');
        const watch = new WatchIterator(config);

        const receivedEvents: WatchEvent<any>[] = [];
        for await (const event of watch.watch('/api/v1/namespaces/default/pods')) {
            receivedEvents.push(event);
        }

        strictEqual(receivedEvents.length, 0);
    });

    it('should handle whitespace-only lines', async () => {
        const event = {
            type: 'ADDED',
            object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
        };
        const responseBody = `${JSON.stringify(event)}\n   \n\n${JSON.stringify(event)}`;
        const config = createMockConfiguration(server, responseBody);
        const watch = new WatchIterator(config);

        const receivedEvents: WatchEvent<any>[] = [];
        for await (const event of watch.watch('/api/v1/namespaces/default/pods')) {
            receivedEvents.push(event);
        }

        strictEqual(receivedEvents.length, 2);
    });
});

describe('WatchIterator with custom HTTP library', () => {
    it('should work with custom HTTP implementation', async () => {
        const events = [
            { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'custom-pod' } } },
        ];
        const responseBody = events.map((e) => JSON.stringify(e)).join('\n');

        // Custom HTTP implementation that transforms response
        const customHttpApi = wrapHttpLibrary({
            async send(request: RequestContext): Promise<ResponseContext> {
                // Verify we receive the request correctly
                strictEqual(request.getHttpMethod(), 'GET');
                strictEqual(request.getUrl().includes('/api/v1/namespaces/default/pods'), true);

                return new ResponseContext(
                    200,
                    { 'content-type': 'application/json' },
                    {
                        text: () => Promise.resolve(responseBody),
                        binary: () => Promise.resolve(Buffer.from(responseBody)),
                    },
                );
            },
        });

        const mockAuth = {
            getName: () => 'mock',
            applySecurityAuthentication: async (_context: RequestContext): Promise<void> => {},
        };

        const configuration = createConfiguration({
            baseServer: new ServerConfiguration(server, {}),
            authMethods: { default: mockAuth },
            httpApi: customHttpApi,
        });

        const watch = new WatchIterator(configuration);

        const receivedEvents: WatchEvent<any>[] = [];
        for await (const event of watch.watch('/api/v1/namespaces/default/pods')) {
            receivedEvents.push(event);
        }

        strictEqual(receivedEvents.length, 1);
        deepStrictEqual(receivedEvents[0].object.metadata?.name, 'custom-pod');
    });
});

describe('createWatchIterator', () => {
    it('should throw on missing cluster', () => {
        const kc = new KubeConfig();
        // No cluster configured

        try {
            createWatchIterator(kc);
            strictEqual(true, false, 'Should have thrown');
        } catch (err) {
            strictEqual((err as Error).message, 'No currently active cluster');
        }
    });

    it('should create WatchIterator from KubeConfig', () => {
        const kc = new KubeConfig();
        Object.assign(kc, fakeConfig);

        const watch = createWatchIterator(kc);
        strictEqual(watch instanceof WatchIterator, true);
    });
});

describe('WatchError', () => {
    it('should have correct properties', () => {
        const error = new WatchError('Test error', 404);
        strictEqual(error.message, 'Test error');
        strictEqual(error.statusCode, 404);
        strictEqual(error.name, 'WatchError');
    });

    it('should work without status code', () => {
        const error = new WatchError('Connection failed');
        strictEqual(error.message, 'Connection failed');
        strictEqual(error.statusCode, undefined);
    });
});

describe('WatchIterator type safety', () => {
    it('should preserve generic type through iteration', async () => {
        interface CustomResource {
            apiVersion?: string;
            kind?: string;
            metadata?: { name: string; namespace: string };
            spec?: { replicas: number };
        }

        const events = [
            {
                type: 'ADDED',
                object: {
                    apiVersion: 'custom.io/v1',
                    kind: 'CustomResource',
                    metadata: { name: 'my-resource', namespace: 'default' },
                    spec: { replicas: 3 },
                },
            },
        ];

        const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
        const config = createMockConfiguration(server, responseBody);
        const watch = new WatchIterator(config);

        for await (const event of watch.watch<CustomResource>('/apis/custom.io/v1/customresources')) {
            // Type should be correctly inferred
            strictEqual(event.object.spec?.replicas, 3);
            strictEqual(event.object.metadata?.name, 'my-resource');
        }
    });
});
