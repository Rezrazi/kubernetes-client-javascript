import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { parseWatchStream, buildRequestContext, sendRawRequest } from './stream-utils.js';
import {
    createConfiguration,
    wrapHttpLibrary,
    ServerConfiguration,
    ResponseContext,
    RequestContext,
} from './gen/index.js';

function makeStream(data: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(data));
            controller.close();
        },
    });
}

function makeChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
}

describe('parseWatchStream', () => {
    it('should parse single event', async () => {
        const event = { type: 'ADDED', object: { metadata: { name: 'pod1' } } };
        const stream = makeStream(JSON.stringify(event) + '\n');

        const events: any[] = [];
        for await (const e of parseWatchStream(stream)) {
            events.push(e);
        }

        strictEqual(events.length, 1);
        deepStrictEqual(events[0].type, 'ADDED');
        deepStrictEqual(events[0].object.metadata.name, 'pod1');
    });

    it('should parse multiple events', async () => {
        const data = [
            { type: 'ADDED', object: { metadata: { name: 'pod1' } } },
            { type: 'MODIFIED', object: { metadata: { name: 'pod1' } } },
            { type: 'DELETED', object: { metadata: { name: 'pod1' } } },
        ];

        const stream = makeStream(data.map((e) => JSON.stringify(e)).join('\n') + '\n');

        const events: any[] = [];
        for await (const e of parseWatchStream(stream)) {
            events.push(e);
        }

        strictEqual(events.length, 3);
        deepStrictEqual(events[0].type, 'ADDED');
        deepStrictEqual(events[1].type, 'MODIFIED');
        deepStrictEqual(events[2].type, 'DELETED');
    });

    it('should handle partial lines across chunks', async () => {
        const event = { type: 'ADDED', object: { metadata: { name: 'pod1' } } };
        const json = JSON.stringify(event);
        const mid = Math.floor(json.length / 2);

        // Split the JSON across two chunks
        const stream = makeChunkedStream([json.substring(0, mid), json.substring(mid) + '\n']);

        const events: any[] = [];
        for await (const e of parseWatchStream(stream)) {
            events.push(e);
        }

        strictEqual(events.length, 1);
        deepStrictEqual(events[0].type, 'ADDED');
    });

    it('should skip empty lines', async () => {
        const event = { type: 'ADDED', object: { metadata: { name: 'pod1' } } };
        const stream = makeStream('\n\n' + JSON.stringify(event) + '\n\n');

        const events: any[] = [];
        for await (const e of parseWatchStream(stream)) {
            events.push(e);
        }

        strictEqual(events.length, 1);
    });

    it('should skip malformed JSON lines', async () => {
        const good = { type: 'ADDED', object: { metadata: { name: 'pod1' } } };
        const stream = makeStream(
            JSON.stringify(good) + '\n' + '{invalid json}\n' + JSON.stringify(good) + '\n',
        );

        const events: any[] = [];
        for await (const e of parseWatchStream(stream)) {
            events.push(e);
        }

        strictEqual(events.length, 2);
    });

    it('should handle empty stream', async () => {
        const stream = makeStream('');

        const events: any[] = [];
        for await (const e of parseWatchStream(stream)) {
            events.push(e);
        }

        strictEqual(events.length, 0);
    });

    it('should handle data without trailing newline', async () => {
        const event = { type: 'ADDED', object: { metadata: { name: 'pod1' } } };
        const stream = makeStream(JSON.stringify(event));

        const events: any[] = [];
        for await (const e of parseWatchStream(stream)) {
            events.push(e);
        }

        // Should still parse the buffered data when stream ends
        strictEqual(events.length, 1);
        deepStrictEqual(events[0].type, 'ADDED');
    });
});

describe('buildRequestContext', () => {
    it('should build a request with path and query params', async () => {
        const mockAuth = {
            getName: () => 'mock',
            applySecurityAuthentication: async (_ctx: RequestContext): Promise<void> => {},
        };

        const config = createConfiguration({
            baseServer: new ServerConfiguration('https://example.com', {}),
            authMethods: { default: mockAuth },
        });

        const ctx = await buildRequestContext(config, '/api/v1/pods', {
            watch: 'true',
            labelSelector: 'app=nginx',
        });

        const url = ctx.getUrl();
        strictEqual(url.includes('https://example.com/api/v1/pods'), true);
        strictEqual(url.includes('watch=true'), true);
        strictEqual(url.includes('labelSelector=app%3Dnginx'), true);
    });

    it('should skip undefined query params', async () => {
        const mockAuth = {
            getName: () => 'mock',
            applySecurityAuthentication: async (_ctx: RequestContext): Promise<void> => {},
        };

        const config = createConfiguration({
            baseServer: new ServerConfiguration('https://example.com', {}),
            authMethods: { default: mockAuth },
        });

        const ctx = await buildRequestContext(config, '/api/v1/pods', {
            watch: 'true',
            labelSelector: undefined,
        });

        const url = ctx.getUrl();
        strictEqual(url.includes('watch=true'), true);
        strictEqual(url.includes('labelSelector'), false);
    });
});

describe('sendRawRequest', () => {
    it('should send request through middleware pipeline', async () => {
        const calls: string[] = [];

        const httpApi = wrapHttpLibrary({
            async send(_request: RequestContext): Promise<ResponseContext> {
                calls.push('send');
                return new ResponseContext(
                    200,
                    {},
                    {
                        text: () => Promise.resolve('ok'),
                        binary: () => Promise.resolve(Buffer.from('ok')),
                        stream: () => null,
                    },
                );
            },
        });

        const config = createConfiguration({
            baseServer: new ServerConfiguration('https://example.com', {}),
            authMethods: {},
            httpApi,
            promiseMiddleware: [
                {
                    async pre(ctx) {
                        calls.push('pre');
                        return ctx;
                    },
                    async post(ctx) {
                        calls.push('post');
                        return ctx;
                    },
                },
            ],
        });

        const ctx = config.baseServer.makeRequestContext('/test', 'GET' as any);
        const response = await sendRawRequest(config, ctx);

        strictEqual(response.httpStatusCode, 200);
        deepStrictEqual(calls, ['pre', 'send', 'post']);
    });
});
