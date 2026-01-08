var _a;
import { KubeConfig, WatchApi } from './src/index.js';
const httpApi = wrapHttpLibrary({
    async send(request) {
        const agent = request.getAgent();
        const response = await ky(request.getUrl(), {
            method: request.getHttpMethod(),
            headers: request.getHeaders(),
            body: request.getBody(),
            hooks: {
                beforeRequest: [
                    (req) => {
                        // @ts-ignore - Bun-specific TLS injection
                        req.tls = {
                            ca: agent === null || agent === void 0 ? void 0 : agent.options.ca,
                            cert: agent.options.cert,
                            key: agent.options.key,
                        };
                    },
                ],
            },
        });
        return new ResponseContext(response.status, Object.fromEntries(response.headers.entries()), {
            text: () => response.text(),
            binary: async () => Buffer.from(await response.arrayBuffer()),
        });
    },
});
const kc = new KubeConfig();
kc.loadFromDefault();
const watchApi = kc.makeApiClient(WatchApi);
for await (const event of watchApi.watch('/api/v1/namespaces/default/pods')) {
    console.log(
        `${event.type}: ${(_a = event.object.metadata) === null || _a === void 0 ? void 0 : _a.name}`,
    );
}
//# sourceMappingURL=run.js.map
