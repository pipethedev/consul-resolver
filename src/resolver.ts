import { log } from "@brimble/utils";
import Consul from "consul";
import Redis from "ioredis";
import {
    leastConnectionSelection,
    roundRobinSelection,
    weightedRandomSelection,
} from "./algorithms";
import { DNSManager } from "./dns";
import { HealthCheckManager } from "./health";
import { MetricsManager } from "./metrics";
import { combineHealthAndDNSWeights, rankServices } from "./scoring";
import {
    ConsulResolverConfig,
    DEFAULT_METRICS,
    DEFAULT_WEIGHTS,
    OptimalServiceResult,
    SelectionAlgorithm,
    ServiceHealth,
    ServiceMetrics,
} from "./types";

class ConsulResolver {
    private currentIndex = 0;
    private consul: Consul;
    private redis: Redis | undefined;
    private cachePrefix: string;
    private weights: typeof DEFAULT_WEIGHTS;
    private metrics: typeof DEFAULT_METRICS;
    private cacheTTL: number;
    private cacheEnabled: boolean;
    private debug: boolean;

    private metricsManager: MetricsManager;
    private dnsManager: DNSManager;
    private healthCheckManager: HealthCheckManager;

    constructor(config: ConsulResolverConfig) {
        this.debug = config.debug || false;
        this.cachePrefix = config.cachePrefix;
        this.cacheEnabled = config.cacheEnabled;
        this.weights = config.weights || DEFAULT_WEIGHTS;
        this.metrics = config.metrics || DEFAULT_METRICS;

        this.cacheTTL = Math.floor((config.cacheTTL || 60 * 1000) / 1000);

        this.consul = new Consul({
            host: config.host,
            port: config.port,
            secure: config.secure,
            defaults: {
                ...(config.token ? { token: config.token } : {}),
            },
            agent: config.agent,
        });

        if (this.cacheEnabled && config.redis) {
            this.redis = config.redis;
            this.cacheEnabled = true;
        }

        this.metricsManager = new MetricsManager(
            this.redis,
            this.cachePrefix,
            this.metrics,
            this.cacheEnabled,
            this.debug
        );

        this.dnsManager = new DNSManager(
            this.redis,
            this.cachePrefix,
            this.cacheTTL,
            this.cacheEnabled,
            this.debug,
            config.dnsEndpoints,
            config.dnsTimeout,
            config.dnsRetries
        );

        this.healthCheckManager = new HealthCheckManager(
            this.consul,
            this.redis,
            this.cachePrefix,
            this.cacheTTL,
            this.cacheEnabled,
            this.debug
        );
    }

    /**
     * Select the optimal service based on the specified algorithm
     */
    async selectOptimalService(
        service: string,
        algorithm: SelectionAlgorithm = SelectionAlgorithm.RoundRobin
    ): Promise<OptimalServiceResult> {
        try {
            const [healthChecks, dnsRecords] = await Promise.all([
                this.healthCheckManager.getHealthChecks(service),
                this.dnsManager.resolveDNS(service)
            ]);

            if ((!healthChecks || healthChecks.length === 0) && dnsRecords.length === 0) {
                return { selected: null, services: [] };
            }

            const sortedByPriority = this.dnsManager.sortByPriority(dnsRecords);

            const lowestPriorityValue = sortedByPriority[0]?.priority;
            const highestPriorityRecords = sortedByPriority.filter(
                record => record.priority === lowestPriorityValue
            );

            if (!healthChecks || healthChecks.length === 0) {
                const { selected, nextIndex } = this.dnsManager.selectFromSrvRecords(
                    highestPriorityRecords,
                    algorithm,
                    this.currentIndex
                );
                this.currentIndex = nextIndex;

                if (!selected) {
                    return { selected: null, services: [] };
                }

                await this.metricsManager.updateSelectionMetrics(selected.name);

                return {
                    selected: {
                        ip: selected.ip,
                        port: selected.port,
                    },
                    services: sortedByPriority.map(record => ({
                        ip: record.ip,
                        port: record.port,
                    })),
                };
            }

            const dnsWeights = new Map<string, { weight: number; port: number; priority: number }>(
                dnsRecords.map((record: any) => [record.ip, {
                    weight: record.weight,
                    port: record.port,
                    priority: record.priority
                }])
            );

            const matchedHealthChecks = healthChecks.filter(check =>
                dnsWeights.has(check.Service.Address)
            );

            if (matchedHealthChecks.length === 0) {
                if (this.debug) {
                    log.debug('No matching services found between DNS and Consul health checks');
                }
                const { selected, nextIndex } = this.dnsManager.selectFromSrvRecords(
                    highestPriorityRecords,
                    algorithm,
                    this.currentIndex
                );
                this.currentIndex = nextIndex;

                if (!selected) {
                    return { selected: null, services: [] };
                }

                await this.metricsManager.updateSelectionMetrics(selected.name);

                return {
                    selected: {
                        ip: selected.ip,
                        port: selected.port,
                    },
                    services: sortedByPriority.map(record => ({
                        ip: record.ip,
                        port: record.port,
                    })),
                };
            }

            const highPriorityIPs = new Set(highestPriorityRecords.map(record => record.ip));
            const highPriorityHealthChecks = matchedHealthChecks.filter(check =>
                highPriorityIPs.has(check.Service.Address)
            );

            const targetHealthChecks = highPriorityHealthChecks.length > 0
                ? highPriorityHealthChecks
                : matchedHealthChecks;

            const maxDNSWeight = Math.max(...dnsRecords.map((r: any) => r.weight || 1));

            const enhancedHealthChecks = targetHealthChecks.map(check => ({
                ...check,
                dnsWeight: combineHealthAndDNSWeights(
                    check,
                    dnsWeights.get(check.Service.Address)?.weight || 0,
                    maxDNSWeight
                )
            }));

            const metrics = await this.metricsManager.getServicesMetrics(targetHealthChecks);
            let selectedService: { id: string; service: ServiceHealth };

            switch (algorithm) {
                case SelectionAlgorithm.RoundRobin:
                    const rrResult = roundRobinSelection(enhancedHealthChecks, this.currentIndex);
                    this.currentIndex = rrResult.nextIndex;
                    selectedService = { id: rrResult.id, service: rrResult.service };
                    break;
                case SelectionAlgorithm.LeastConnection:
                    selectedService = leastConnectionSelection(enhancedHealthChecks, metrics, this.metrics);
                    break;
                case SelectionAlgorithm.WeightedRoundRobin:
                    const rankedServices = rankServices(enhancedHealthChecks, metrics, this.weights);
                    rankedServices.forEach(ranked => {
                        const dnsInfo = dnsWeights.get(ranked.service.Service.Address);
                        if (dnsInfo) {
                            ranked.score *= (1 + (dnsInfo.weight / maxDNSWeight));
                        }
                    });
                    selectedService = weightedRandomSelection(rankedServices);
                    break;
            }

            await this.metricsManager.updateSelectionMetrics(selectedService.id);

            const selectedDNSInfo = dnsWeights.get(selectedService.service.Service.Address);

            return {
                selected: {
                    ip: selectedService.service.Service.Address,
                    port: selectedDNSInfo?.port || selectedService.service.Service.Port,
                },
                services: matchedHealthChecks.map(check => {
                    const dnsInfo = dnsWeights.get(check.Service.Address);
                    return {
                        ip: check.Service.Address,
                        port: dnsInfo?.port || check.Service.Port,
                    };
                }),
            };
        } catch (error) {
            if (this.debug) {
                log.error('Error selecting optimal service:', error);
            }
            return { selected: null, services: [] };
        }
    }

    async incrementConnections(serviceId: string): Promise<void> {
        return this.metricsManager.incrementConnections(serviceId);
    }

    async decrementConnections(serviceId: string): Promise<void> {
        return this.metricsManager.decrementConnections(serviceId);
    }

    async getSelectionMetrics(serviceId: string): Promise<ServiceMetrics | null> {
        return this.metricsManager.getSelectionMetrics(serviceId);
    }

    async refresh(): Promise<void> {
        try {
            if (!this.cacheEnabled) {
                if (this.debug) {
                    log.debug("Cache is disabled, no need to refresh");
                }
                return;
            }
            const pattern = `${this.cachePrefix}:*`;
            const keys = await this.redis?.keys(pattern);

            if (keys && keys.length > 0) {
                await this.redis?.del(...keys);
            }
        } catch (error: any) {
            console.log("Error refreshing Redis caches:", error);
            throw new Error(`Failed to refresh caches: ${error.message}`);
        }
    }
}

export default ConsulResolver;
