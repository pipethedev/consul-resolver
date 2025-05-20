import { query } from 'dns-query';
import Redis from "ioredis";
import Consul from "consul";
import {
    ConsulResolverConfig,
    ServiceMetrics,
    ServiceHealth,
    SelectionAlgorithm,
    DEFAULT_WEIGHTS,
    DEFAULT_METRICS,
    OptimalServiceResult,
    SrvRecord
} from "./types";
import { log } from "@brimble/utils";

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

    constructor(private config: ConsulResolverConfig) {
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

        if(this.cacheEnabled) {
            this.redis = config.redis;
        }
    }

    private getConnectionKey(serviceId: string): string {
        return `${this.cachePrefix}:connections:${serviceId}`;
    }
    
    private getDNSCacheKey(service: string): string {
        return `${this.cachePrefix}:dns:${service}`;
    }
    
    private getHealthCacheKey(service: string): string {
        return `${this.cachePrefix}:health:${service}`;
    }

    private async resolveDNS(service: string) {
        const cacheKey = this.getDNSCacheKey(service);

        if(this.cacheEnabled) {
            const cachedData = await this.redis?.get(cacheKey);
    
            if (cachedData) {
                if(this.debug) {
                    log.debug(`DNS cache hit for ${service}`);
                }
                return JSON.parse(cachedData);
            }
        }
        
        try {
            const result = await query(
                { 
                    question: { 
                        type: 'SRV',
                        name: `${service}.service.consul` 
                    } 
                },
                {
                    endpoints: [
                        `udp://${this.config.host}:8600`,
                        ...(this.config.dnsEndpoints || []).map(endpoint => `udp://${endpoint}`)
                    ],
                    timeout: this.config.dnsTimeout || 5000,
                    retries: this.config.dnsRetries || 2
                }
            );
            
            if (!result.answers || result.answers.length === 0) {
                if(this.debug) {
                    log.debug(`No SRV records found for ${service}`);
                }
                return [];
            }
            
            const records = result.answers.map((answer: any) => {
                const aRecord = result.additionals?.find(
                    (additional) => additional.name === (answer.data as any).target && additional.type === 'A'
                );
                
                return {
                    name: (answer.data as any).target,
                    ip: aRecord?.data || '',
                    port: (answer.data as any).port,
                    priority: (answer.data as any).priority,
                    weight: (answer.data as any).weight
                };
            }).filter(record => record.ip);
            
            if(this.cacheEnabled) {
                await this.redis?.set(
                    cacheKey, 
                    JSON.stringify(records),
                    'EX',
                    this.cacheTTL
                );
            }
            
            return records;
        } catch (error) {
            if(this.debug) {
                log.error('DNS resolution error:', error);
            }
            return [];
        }
    }

    private combineHealthAndDNSWeights(
        service: ServiceHealth,
        dnsWeight: number,
        maxDNSWeight: number
    ): number {
        const healthScore = this.calculateHealthScore(service);
        const normalizedDNSWeight = dnsWeight / maxDNSWeight;
        return (healthScore * 0.7) + (normalizedDNSWeight * 0.3);
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
                this.getHealthChecks(service),
                this.resolveDNS(service)
            ]);

            if ((!healthChecks || healthChecks.length === 0) && dnsRecords.length === 0) {
                return { selected: null, services: [] };
            }
            
            const sortedByPriority = this.sortByPriority(dnsRecords);
            
            const lowestPriorityValue = sortedByPriority[0]?.priority;
            const highestPriorityRecords = sortedByPriority.filter(
                record => record.priority === lowestPriorityValue
            );
            
            if (!healthChecks || healthChecks.length === 0) {
                const selected = this.selectFromSrvRecords(highestPriorityRecords, algorithm);
                
                if (!selected) {
                    return { selected: null, services: [] };
                }
                
                await this.updateSelectionMetrics(selected.name);
                
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
                if(this.debug) {
                    log.debug('No matching services found between DNS and Consul health checks');
                }
                const selected = this.selectFromSrvRecords(highestPriorityRecords, algorithm);
                
                if (!selected) {
                    return { selected: null, services: [] };
                }
                
                await this.updateSelectionMetrics(selected.name);
                
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
                dnsWeight: this.combineHealthAndDNSWeights(
                    check,
                    dnsWeights.get(check.Service.Address)?.weight || 0,
                    maxDNSWeight
                )
            }));

            const metrics = await this.getServicesMetrics(targetHealthChecks);
            let selectedService: { id: string; service: ServiceHealth };

            switch (algorithm) {
                case SelectionAlgorithm.RoundRobin:
                    selectedService = this.roundRobinSelection(enhancedHealthChecks);
                    break;
                case SelectionAlgorithm.LeastConnection:
                    selectedService = this.leastConnectionSelection(enhancedHealthChecks, metrics);
                    break;
                case SelectionAlgorithm.WeightedRoundRobin:
                    const rankedServices = await this.rankServices(enhancedHealthChecks, metrics);
                    rankedServices.forEach(ranked => {
                        const dnsInfo = dnsWeights.get(ranked.service.Service.Address);
                        if (dnsInfo) {
                            ranked.score *= (1 + (dnsInfo.weight / maxDNSWeight));
                        }
                    });
                    selectedService = this.weightedRandomSelection(rankedServices);
                    break;
            }

            await this.updateSelectionMetrics(selectedService.id);

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
            if(this.debug) {
                log.error('Error selecting optimal service:', error);
            }
            return { selected: null, services: [] };
        }
    }
    
    /**
     * Get health checks from Consul with caching
     */
    private async getHealthChecks(service: string): Promise<ServiceHealth[]> {
        const cacheKey = this.getHealthCacheKey(service);
        
        if(this.cacheEnabled) {
            const cachedHealth = await this.redis?.get(cacheKey);
            if (cachedHealth) {
                return JSON.parse(cachedHealth);
            }
        }
        
        try {
            const healthChecks = await this.consul.health.service(service);

            if(this.cacheEnabled) {
                await this.redis?.set(
                    cacheKey,
                    JSON.stringify(healthChecks),
                    'EX',
                    this.cacheTTL
                );
            }

            return healthChecks;
        } catch (error) {
            if(this.debug) {
                log.error(`Error fetching health checks for ${service}:`, error);
            }
            return [];
        }
    }
    
    /**
     * Sort SRV records by priority (lower number is higher priority)
     */
    private sortByPriority(records: SrvRecord[]): SrvRecord[] {
        return [...records].sort((a, b) => (a.priority || 0) - (b.priority || 0));
    }
    
    /**
     * Select a service from SRV records using the specified algorithm
     */
    private selectFromSrvRecords(
        records: SrvRecord[],
        algorithm: SelectionAlgorithm
    ): SrvRecord | null {
        if (!records || records.length === 0) {
            return null;
        }
        
        switch (algorithm) {
            case SelectionAlgorithm.RoundRobin:
                const selected = records[this.currentIndex % records.length];
                this.currentIndex = (this.currentIndex + 1) % records.length;
                return selected;
                
            case SelectionAlgorithm.WeightedRoundRobin:
                return this.selectWeightedSrvRecord(records);
                
            case SelectionAlgorithm.LeastConnection:
                const selectedLC = records[this.currentIndex % records.length];
                this.currentIndex = (this.currentIndex + 1) % records.length;
                return selectedLC;
                
            default:
                return records[0];
        }
    }
    
    /**
     * Select SRV record using weighted random selection
     */
    private selectWeightedSrvRecord(records: SrvRecord[]): SrvRecord | null {
        if (!records || records.length === 0) {
            return null;
        }
        
        const hasNonZeroWeights = records.some(record => (record.weight || 0) > 0);
        
        if (!hasNonZeroWeights) {
            return records[this.currentIndex++ % records.length];
        }
        
        const totalWeight = records.reduce((sum, record) => sum + (record.weight || 1), 0);
        
        let random = Math.random() * totalWeight;
        
        for (const record of records) {
            random -= (record.weight || 1);
            if (random <= 0) {
                return record;
            }
        }
        
        return records[0];
    }

    private roundRobinSelection(services: ServiceHealth[]): {
        id: string;
        service: ServiceHealth;
    } {
        const healthyServices = services.filter((service) =>
            service.Checks.every((check) => check.Status === "passing"),
        );

        if (healthyServices.length === 0) {
            throw new Error("No healthy services available");
        }

        const service = healthyServices[this.currentIndex % healthyServices.length];
        this.currentIndex = (this.currentIndex + 1) % healthyServices.length;

        return {
            id: service.Service.ID,
            service,
        };
    }

    private leastConnectionSelection(
        services: ServiceHealth[],
        metrics: Map<string, ServiceMetrics>,
    ): { id: string; service: ServiceHealth } {
        const healthyServices = services
            .filter((service) =>
                service.Checks.every((check) => check.Status === "passing"),
            )
            .map((service) => {
                const serviceMetrics = metrics.get(service.Service.ID) || this.metrics;
                return {
                    service,
                    connections: serviceMetrics.activeConnections || 0,
                };
            });

        if (healthyServices.length === 0) {
            throw new Error("No healthy services available");
        }

        const selectedService = healthyServices.reduce((min, current) =>
            current.connections < min.connections ? current : min,
        );

        return {
            id: selectedService.service.Service.ID,
            service: selectedService.service,
        };
    }

    private async getServicesMetrics(
        services: ServiceHealth[],
    ): Promise<Map<string, ServiceMetrics>> {
        const metricsMap = new Map<string, ServiceMetrics>();
        const pipeline = this.redis?.pipeline();

        if(this.cacheEnabled) {
            services.forEach((service) => {
                pipeline?.get(service.Service.ID);
                pipeline?.get(this.getConnectionKey(service.Service.ID));
            });
        }

        try {
            const results = await pipeline?.exec();
            if (!results) {
                services.forEach((service) => {
                    metricsMap.set(service.Service.ID, { ...this.metrics });
                });
                return metricsMap;
            }

            services.forEach((service, index) => {
                const serviceId = service.Service.ID;
                const metricsResult = results[index * 2];
                const connectionsResult = results[index * 2 + 1];

                let metrics: ServiceMetrics;

                try {
                    if (metricsResult?.[1]) {
                        metrics = JSON.parse(metricsResult[1] as string);
                    } else {
                        metrics = { ...this.metrics };
                    }

                    const connections = connectionsResult?.[1]
                        ? parseInt(connectionsResult[1] as string)
                        : 0;
                    metrics.activeConnections = connections;

                    metricsMap.set(serviceId, metrics);
                } catch (error) {
                    if(this.debug) {
                        log.error(
                            `Error processing metrics for service ${serviceId}:`,
                            error,
                        );
                    }
                    metricsMap.set(serviceId, { ...this.metrics });
                }
            });
        } catch (error) {
            if(this.debug) {
                log.error("Error executing Redis pipeline:", error);
            }
            services.forEach((service) => {
                metricsMap.set(service.Service.ID, { ...this.metrics });
            });
        }

        return metricsMap;
    }

    private async rankServices(
        services: ServiceHealth[],
        metrics: Map<string, ServiceMetrics>,
    ): Promise<Array<{ score: number; id: string; service: ServiceHealth }>> {
        return services
            .map((service) => {
                const serviceId = service.Service.ID;

                const serviceMetrics = metrics.get(serviceId);

                if (!serviceMetrics) {
                    throw new Error(`No metrics found for service ${serviceId}`);
                }

                const healthScore = this.calculateHealthScore(service);
                const responseTimeScore = this.normalizeScore(
                    serviceMetrics.responseTime,
                    500,
                    true,
                );
                const errorRateScore = this.normalizeScore(
                    serviceMetrics.errorRate,
                    100,
                    true,
                );
                const resourceScore = this.calculateResourceScore(serviceMetrics);
                const connectionScore = this.normalizeScore(
                    serviceMetrics.activeConnections,
                    1000,
                    true,
                );
                const distributionScore = this.calculateDistributionScore(
                    serviceMetrics.lastSelectedTime,
                );

                const totalScore =
                    healthScore * this.weights.health +
                    responseTimeScore * this.weights.responseTime +
                    errorRateScore * this.weights.errorRate +
                    resourceScore * this.weights.resources +
                    connectionScore * this.weights.connections +
                    distributionScore * this.weights.distribution;

                return {
                    score: totalScore,
                    id: serviceId,
                    service,
                };
            })
            .sort((a, b) => b.score - a.score);
    }

    private calculateHealthScore(service: ServiceHealth): number {
        const checks = service.Checks;
        const totalChecks = checks.length;
        if (totalChecks === 0) return 0;
        
        const passingChecks = checks.filter(
            (check) => check.Status === "passing",
        ).length;
        return passingChecks / totalChecks;
    }

    private calculateResourceScore(metrics: ServiceMetrics): number {
        const cpuScore = this.normalizeScore(metrics.cpuUsage, 100, true);
        const memoryScore = this.normalizeScore(metrics.memoryUsage, 100, true);
        return (cpuScore + memoryScore) / 2;
    }

    private calculateDistributionScore(lastSelectedTime?: number): number {
        if (!lastSelectedTime) return 1;

        const timeSinceLastSelection = Date.now() - lastSelectedTime;

        return Math.min(timeSinceLastSelection / (5 * 60 * 1000), 1);
    }

    private normalizeScore(value: number, max: number, inverse = false): number {
        const normalized = Math.max(0, Math.min(1, value / max));
        return inverse ? 1 - normalized : normalized;
    }

    private weightedRandomSelection(
        rankedServices: Array<{
            score: number;
            id: string;
            service: ServiceHealth;
        }>,
    ): { id: string; service: ServiceHealth } {
        if (rankedServices.length === 0) {
            throw new Error("No services available for selection");
        }
        
        const totalScore = rankedServices.reduce(
            (sum, service) => sum + service.score,
            0,
        );
        
        if (totalScore <= 0) {
            return {
                id: rankedServices[0].id,
                service: rankedServices[0].service,
            };
        }
        
        let random = Math.random() * totalScore;

        for (const service of rankedServices) {
            random -= service.score;
            if (random <= 0) {
                return {
                    id: service.id,
                    service: service.service,
                };
            }
        }

        return {
            id: rankedServices[0].id,
            service: rankedServices[0].service,
        };
    }

    async incrementConnections(serviceId: string): Promise<void> {
        try {
            const connectionKey = this.getConnectionKey(serviceId);
            const existingMetrics = await this.redis?.get(connectionKey);
            let metrics: ServiceMetrics;

            if (existingMetrics) {
                metrics = JSON.parse(existingMetrics);
                metrics.activeConnections = (metrics.activeConnections || 0) + 1;
            } else {
                metrics = {
                    ...this.metrics,
                    activeConnections: 1,
                };
            }

            if (this.cacheEnabled) {
                await this.redis?.set(
                    connectionKey,
                    JSON.stringify(metrics),
                    "EX",
                    24 * 60 * 60,
                );
            }
        } catch (error) {
            if(this.debug) {
                log.error(
                    `Failed to increment connections for service ${serviceId}:`,
                    error,
                );
            }
        }
    }

    async decrementConnections(serviceId: string): Promise<void> {
        try {
            const connectionKey = this.getConnectionKey(serviceId);
            const existingMetrics = await this.redis?.get(connectionKey);
            let metrics: ServiceMetrics;

            if (existingMetrics) {
                metrics = JSON.parse(existingMetrics);
                metrics.activeConnections = Math.max(
                    0,
                    (metrics.activeConnections || 1) - 1,
                );
            } else {
                metrics = {
                    ...this.metrics,
                    activeConnections: 0,
                };
            }

            if (this.cacheEnabled) {
                await this.redis?.set(
                    connectionKey,
                    JSON.stringify(metrics),
                    "EX",
                    24 * 60 * 60,
                );
            }
        } catch (error) {
            if(this.debug) {
                log.error(
                    `Failed to decrement connections for service ${serviceId}:`,
                    error,
                );
            }
        }
    }

    private async updateSelectionMetrics(serviceId: string): Promise<void> {
        try {
            const connectionKey = this.getConnectionKey(serviceId);
            const existingMetrics = await this.redis?.get(connectionKey);
            let metrics: ServiceMetrics;

            if (existingMetrics) {
                metrics = JSON.parse(existingMetrics);
            } else {
                metrics = { ...this.metrics };
            }

            metrics.lastSelectedTime = Date.now();

            if (this.cacheEnabled) {
                await this.redis?.set(
                    connectionKey,
                    JSON.stringify(metrics),
                    "EX",
                    24 * 60 * 60,
                );
            }
        } catch (error) {
            if(this.debug) {
                log.error(
                    `Failed to update selection metrics for service ${serviceId}:`,
                    error,
                );
            }
        }
    }

    async getSelectionMetrics(serviceId: string): Promise<ServiceMetrics | null> {
        try {
            if (!this.cacheEnabled) {
                return null;
            }
            const metrics = await this.redis?.get(this.getConnectionKey(serviceId));
            return metrics ? JSON.parse(metrics) : null;
        } catch (error) {
            if(this.debug) {
                log.error("Error getting service metrics:", error);
            }
            return null;
        }
    }

    async refresh(): Promise<void> {
        try {
            if (!this.cacheEnabled) {
                if(this.debug) {
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