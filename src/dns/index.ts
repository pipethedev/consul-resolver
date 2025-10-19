import { log } from "@brimble/utils";
import { query } from 'dns-query';
import Redis from "ioredis";
import { roundRobinSrvSelection, weightedSrvRecordSelection } from "../algorithms";
import { SelectionAlgorithm, SrvRecord } from "../types";

export class DNSManager {
    constructor(
        private redis: Redis | undefined,
        private cachePrefix: string,
        private cacheTTL: number,
        private cacheEnabled: boolean,
        private debug: boolean,
        private dnsEndpoints?: string[],
        private dnsTimeout?: number,
        private dnsRetries?: number
    ) {}

    private getDNSCacheKey(service: string): string {
        return `${this.cachePrefix}:dns:${service}`;
    }

    async resolveDNS(service: string): Promise<SrvRecord[]> {
        const cacheKey = this.getDNSCacheKey(service);

        if (this.cacheEnabled) {
            try {
                const cachedData = await Promise.race([
                    this.redis?.get(cacheKey),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Redis get timeout')), 200))
                ]);
                if (cachedData) {
                    if (this.debug) {
                        log.debug(`DNS cache hit for ${service}`);
                    }
                    return JSON.parse(cachedData as string);
                }
            } catch (e) {
                if (this.debug) log.error('Redis get error or timeout:', e);
            }
        }

        try {
            const result = await query(
                {
                    question: {
                        type: 'SRV',
                        name: service
                    }
                },
                {
                    endpoints: this.dnsEndpoints,
                    timeout: this.dnsTimeout ?? 1500,
                    retries: this.dnsRetries ?? 2
                }
            );

            if (this.debug) {
                log.debug("DNS QUERY RESULT", result);
            }

            if (!result.answers || result.answers.length === 0) {
                if (this.debug) {
                    log.debug(`No SRV records found for ${service}`);
                }
                return [];
            }

            const additionalsByName: Record<string, any> = {};
            if (result.additionals) {
                for (const additional of result.additionals) {
                    if (additional.type === 'A') {
                        additionalsByName[additional.name] = additional;
                    }
                }
            }
            const records = result.answers.map((answer: any) => {
                const target = (answer.data as any).target;
                const aRecord = additionalsByName[target];
                return {
                    name: target,
                    ip: aRecord?.data || '',
                    port: (answer.data as any).port,
                    priority: (answer.data as any).priority,
                    weight: (answer.data as any).weight
                };
            }).filter(record => record.ip);

            if (this.cacheEnabled) {
                try {
                    await Promise.race([
                        this.redis?.set(
                            cacheKey,
                            JSON.stringify(records),
                            'EX',
                            this.cacheTTL
                        ),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis set timeout')), 200))
                    ]);
                } catch (e) {
                    if (this.debug) log.error('Redis set error or timeout:', e);
                }
            }

            return records;
        } catch (error) {
            if (this.debug) {
                log.error('DNS resolution error:', error);
            }
            return [];
        }
    }

    sortByPriority(records: SrvRecord[]): SrvRecord[] {
        return [...records].sort((a, b) => (a.priority || 0) - (b.priority || 0));
    }

    selectFromSrvRecords(
        records: SrvRecord[],
        algorithm: SelectionAlgorithm,
        currentIndex: number
    ): { selected: SrvRecord | null; nextIndex: number } {
        if (!records || records.length === 0) {
            return { selected: null, nextIndex: currentIndex };
        }

        switch (algorithm) {
            case SelectionAlgorithm.RoundRobin:
                const rrResult = roundRobinSrvSelection(records, currentIndex);
                if (!rrResult) {
                    return { selected: null, nextIndex: currentIndex };
                }
                return { selected: rrResult.selected, nextIndex: rrResult.nextIndex };

            case SelectionAlgorithm.WeightedRoundRobin:
                const wrResult = weightedSrvRecordSelection(records, currentIndex);
                if (!wrResult) {
                    return { selected: null, nextIndex: currentIndex };
                }
                return { selected: wrResult.selected, nextIndex: wrResult.nextIndex };

            case SelectionAlgorithm.LeastConnection:
                const lcResult = roundRobinSrvSelection(records, currentIndex);
                if (!lcResult) {
                    return { selected: null, nextIndex: currentIndex };
                }
                return { selected: lcResult.selected, nextIndex: lcResult.nextIndex };

            default:
                return { selected: records[0], nextIndex: currentIndex };
        }
    }
}
