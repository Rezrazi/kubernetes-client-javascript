import { ListWatch, type ObjectCache } from './cache.js';
import { Configuration } from './gen/configuration.js';
import { KubernetesObject } from './types.js';
import { Informer, ListPromise, Watchable } from './informer.js';
import { WatchApi } from './watch-api.js';

class WatchApiAdapter implements Watchable {
    private readonly watchApi: WatchApi;

    constructor(watchApi: WatchApi) {
        this.watchApi = watchApi;
    }

    public async watch(
        path: string,
        queryParams: Record<string, string | number | boolean | undefined>,
        callback: (phase: string, apiObj: any, watchObj?: any) => void,
        done: (err: any) => void,
    ): Promise<AbortController> {
        return this.watchApi.watch(path, queryParams, callback, done);
    }
}

/**
 * Create an Informer that uses the Configuration-based WatchApi.
 *
 * @param configuration - Configuration object (from KubeConfig.makeConfiguration() or createConfiguration())
 * @param path - API path for the resource to watch
 * @param listPromiseFn - Function that returns a promise of the resource list
 * @param labelSelector - Optional label selector to filter resources
 */
export function makeInformerApi<T extends KubernetesObject>(
    configuration: Configuration,
    path: string,
    listPromiseFn: ListPromise<T>,
    labelSelector?: string,
): Informer<T> & ObjectCache<T> {
    const watchApi = new WatchApi(configuration);
    const adapter = new WatchApiAdapter(watchApi);
    return new ListWatch<T>(path, adapter, listPromiseFn, false, labelSelector);
}
