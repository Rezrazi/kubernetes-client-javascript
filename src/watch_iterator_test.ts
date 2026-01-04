import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, rejects } from 'node:assert';
import { createServer, ServerResponse, IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { KubeConfig } from './config.js';
import { Cluster, Context, User } from './config_types.js';
import { WatchApi, WatchEvent } from './watch_iterator.js';
import { ApiException } from './gen/index.js';

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
            name: 'context',
        } as Context,
    ],
    users: [
        {
            name: 'user',
        } as User,
    ],
};

/**
 * Creates a KubeConfig with a test HTTP server that allows HTTP connections.
 */
function createKubeConfigForServer(serverUrl: string): KubeConfig {
    const kc = new KubeConfig();
    Object.assign(kc, {
        clusters: [{ name: 'cluster', server: serverUrl, skipTLSVerify: true } as Cluster],
        contexts: [{ cluster: 'cluster', user: 'user', name: 'context' } as Context],
        users: [{ name: 'user' } as User],
    });
    kc.setCurrentContext('context');
    return kc;
}

/**
 * Creates a test HTTP server that responds with the given body.
 */
async function createTestServer(
    responseBody: string,
    statusCode: number = 200,
): Promise<{ url: string; close: () => void }> {
    return new Promise((resolve) => {
        const testServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            res.statusCode = statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(responseBody);
        });

        testServer.listen(0, '127.0.0.1', () => {
            const address = testServer.address() as AddressInfo;
            resolve({
                url: `http://127.0.0.1:${address.port}`,
                close: () => testServer.close(),
            });
        });
    });
}

describe('WatchApi', () => {
    it('should construct correctly', () => {
        const kc = new KubeConfig();
        Object.assign(kc, fakeConfig);
        kc.setCurrentContext('context');
        const watchApi = kc.makeApiClient(WatchApi);
        strictEqual(watchApi instanceof WatchApi, true);
    });

    it('should iterate over watch events', async () => {
        const events = [
            { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
            { type: 'MODIFIED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
            { type: 'DELETED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
        ];

        const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
        const testServer = await createTestServer(responseBody);

        try {
            const kc = createKubeConfigForServer(testServer.url);
            const watchApi = kc.makeApiClient(WatchApi);

            const receivedEvents: WatchEvent<any>[] = [];
            for await (const event of watchApi.watch('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 3);
            deepStrictEqual(receivedEvents[0].type, 'ADDED');
            deepStrictEqual(receivedEvents[1].type, 'MODIFIED');
            deepStrictEqual(receivedEvents[2].type, 'DELETED');
            deepStrictEqual(receivedEvents[0].object.metadata?.name, 'pod1');
        } finally {
            testServer.close();
        }
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
        const testServer = await createTestServer(responseBody);

        try {
            const kc = createKubeConfigForServer(testServer.url);
            const watchApi = kc.makeApiClient(WatchApi);

            const receivedEvents: WatchEvent<any>[] = [];
            for await (const event of watchApi.watch('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 2);
            deepStrictEqual(receivedEvents[1].type, 'BOOKMARK');
        } finally {
            testServer.close();
        }
    });

    it('should handle ERROR events in the watch stream', async () => {
        const events = [
            { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } } },
            { type: 'ERROR', object: { code: 410, message: 'Gone', reason: 'Expired' } },
        ];

        const responseBody = events.map((e) => JSON.stringify(e)).join('\n');
        const testServer = await createTestServer(responseBody);

        try {
            const kc = createKubeConfigForServer(testServer.url);
            const watchApi = kc.makeApiClient(WatchApi);

            const receivedEvents: WatchEvent<any>[] = [];
            for await (const event of watchApi.watch('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 2);
            deepStrictEqual(receivedEvents[1].type, 'ERROR');
            deepStrictEqual(receivedEvents[1].object.code, 410);
        } finally {
            testServer.close();
        }
    });

    it('should throw ApiException on non-200 status', async () => {
        const testServer = await createTestServer('Internal Server Error', 500);

        try {
            const kc = createKubeConfigForServer(testServer.url);
            const watchApi = kc.makeApiClient(WatchApi);

            await rejects(
                async () => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for await (const event of watchApi.watch('/api/v1/namespaces/default/pods')) {
                        // Should not reach here
                    }
                },
                (err: Error) => {
                    strictEqual(err instanceof ApiException, true);
                    strictEqual((err as ApiException<unknown>).code, 500);
                    return true;
                },
            );
        } finally {
            testServer.close();
        }
    });

    it('should skip invalid JSON lines', async () => {
        const validEvent = {
            type: 'ADDED',
            object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
        };
        const responseBody = `${JSON.stringify(validEvent)}\n{"invalid json\n${JSON.stringify(validEvent)}`;
        const testServer = await createTestServer(responseBody);

        try {
            const kc = createKubeConfigForServer(testServer.url);
            const watchApi = kc.makeApiClient(WatchApi);

            const receivedEvents: WatchEvent<any>[] = [];
            for await (const event of watchApi.watch('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            // Should only receive 2 valid events, skipping the invalid JSON line
            strictEqual(receivedEvents.length, 2);
        } finally {
            testServer.close();
        }
    });

    it('should pass query parameters correctly', async () => {
        let capturedUrl: string = '';

        const testServer = await new Promise<{ url: string; close: () => void }>((resolve) => {
            const server = createServer((req: IncomingMessage, res: ServerResponse) => {
                capturedUrl = req.url || '';
                const event = {
                    type: 'ADDED',
                    object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod1' } },
                };
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(event));
            });

            server.listen(0, '127.0.0.1', () => {
                const address = server.address() as AddressInfo;
                resolve({
                    url: `http://127.0.0.1:${address.port}`,
                    close: () => server.close(),
                });
            });
        });

        try {
            const kc = createKubeConfigForServer(testServer.url);
            const watchApi = kc.makeApiClient(WatchApi);

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const event of watchApi.watch('/api/v1/namespaces/default/pods', {
                resourceVersion: '12345',
                labelSelector: 'app=nginx',
                fieldSelector: 'metadata.name=my-pod',
                allowWatchBookmarks: true,
            })) {
                // Just consume the event
            }

            strictEqual(capturedUrl.includes('watch=true'), true);
            strictEqual(capturedUrl.includes('resourceVersion=12345'), true);
            strictEqual(capturedUrl.includes('labelSelector=app%3Dnginx'), true);
            strictEqual(capturedUrl.includes('fieldSelector=metadata.name%3Dmy-pod'), true);
            strictEqual(capturedUrl.includes('allowWatchBookmarks=true'), true);
        } finally {
            testServer.close();
        }
    });

    it('should handle empty response', async () => {
        const testServer = await createTestServer('');

        try {
            const kc = createKubeConfigForServer(testServer.url);
            const watchApi = kc.makeApiClient(WatchApi);

            const receivedEvents: WatchEvent<any>[] = [];
            for await (const event of watchApi.watch('/api/v1/namespaces/default/pods')) {
                receivedEvents.push(event);
            }

            strictEqual(receivedEvents.length, 0);
        } finally {
            testServer.close();
        }
    });
});

describe('WatchApi type safety', () => {
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
        const testServer = await createTestServer(responseBody);

        try {
            const kc = createKubeConfigForServer(testServer.url);
            const watchApi = kc.makeApiClient(WatchApi);

            for await (const event of watchApi.watch<CustomResource>('/apis/custom.io/v1/customresources')) {
                // Type should be correctly inferred
                strictEqual(event.object.spec?.replicas, 3);
                strictEqual(event.object.metadata?.name, 'my-resource');
            }
        } finally {
            testServer.close();
        }
    });
});
