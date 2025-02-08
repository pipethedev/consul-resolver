import Consul from "consul";
import Redis from "ioredis";
import {
    ConsulResolverConfig,
    ServiceMetrics,
    ServiceHealth,
    SelectionAlgorithm,
    DEFAULT_WEIGHTS,
    DEFAULT_METRICS,
    OptimalServiceResult,
} from "./types";

class ConsulResolver {
    private currentIndex = 0;

    private consul: Consul;

    private redis: Redis;

    private cachePrefix: string;

    private weights: typeof DEFAULT_WEIGHTS;

    private metrics: typeof DEFAULT_METRICS;

    constructor(private config: ConsulResolverConfig) {
        this.redis = config.redis;
        this.cachePrefix = config.cachePrefix;
        if (config.weights) {
            this.weights = config.weights;
        } else {
            this.weights = DEFAULT_WEIGHTS;
        }

        if (config.metrics) {
            this.metrics = config.metrics;
        } else {
            this.metrics = DEFAULT_METRICS;
        }

        this.consul = new Consul({
            host: config.host,
            port: config.port,
            secure: config.secure,
            defaults: {
                ...(config.token ? { token: config.token } : {}),
            },
            agent: config.agent,
        });
    }

    private getConnectionKey(serviceId: string): string {
        return `${this.cachePrefix}:connections:${serviceId}`;
    }

    async selectOptimalService(
        service: string,
        algorithm: SelectionAlgorithm = SelectionAlgorithm.RoundRobin,
    ): Promise<OptimalServiceResult> {
        try {
            const healthChecks = await this.consul.health.service(service);

            if (!healthChecks || healthChecks.length === 0)
                return { selected: null, services: [] };

            const metrics = await this.getServicesMetrics(healthChecks);

            let selectedService: { id: string; service: ServiceHealth };

            switch (algorithm) {
                case SelectionAlgorithm.RoundRobin:
                    selectedService = this.roundRobinSelection(healthChecks);
                    break;
                case SelectionAlgorithm.LeastConnection:
                    selectedService = this.leastConnectionSelection(
                        healthChecks,
                        metrics,
                    );
                    break;
                case SelectionAlgorithm.WeightedRoundRobin:
                    const rankedServices = await this.rankServices(healthChecks, metrics);
                    selectedService = this.weightedRandomSelection(rankedServices);
                    break;
            }

            await this.updateSelectionMetrics(selectedService.id);

            return {
                selected: {
                    ip: selectedService.service.Service.Address,
                    port: selectedService.service.Service.Port,
                },
                services: healthChecks.map((check: ServiceHealth) => ({
                    ip: check.Service.Address,
                    port: check.Service.Port,
                })),
            };
        } catch (error: any) {
            console.error("Error selecting optimal service:", error);
            return { selected: null, services: [] };
        }
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

        const service = healthyServices[this.currentIndex];

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
                const serviceMetrics =
                    metrics.get(service.Service.ID) || this.metrics;
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
        const pipeline = this.redis.pipeline();

        services.forEach((service) => {
            pipeline.get(service.Service.ID);
            pipeline.get(this.getConnectionKey(service.Service.ID));
        });

        try {
            const results = await pipeline.exec();
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
                    console.warn(
                        `Error processing metrics for service ${serviceId}:`,
                        error,
                    );
                    metricsMap.set(serviceId, { ...this.metrics });
                }
            });
        } catch (error) {
            console.error("Error executing Redis pipeline:", error);
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

                if (!serviceMetrics)
                    throw new Error(`No metrics found for service ${serviceId}`);

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
        const totalScore = rankedServices.reduce(
            (sum, service) => sum + service.score,
            0,
        );
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
            const existingMetrics = await this.redis.get(connectionKey);
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

            await this.redis.set(
                connectionKey,
                JSON.stringify(metrics),
                "EX",
                24 * 60 * 60,
            );
        } catch (error) {
            console.warn(
                `Failed to increment connections for service ${serviceId}:`,
                error,
            );
        }
    }

    async decrementConnections(serviceId: string): Promise<void> {
        try {
            const connectionKey = this.getConnectionKey(serviceId);
            const existingMetrics = await this.redis.get(connectionKey);
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

            await this.redis.set(
                connectionKey,
                JSON.stringify(metrics),
                "EX",
                24 * 60 * 60,
            );
        } catch (error) {
            console.warn(
                `Failed to decrement connections for service ${serviceId}:`,
                error,
            );
        }
    }

    private async updateSelectionMetrics(serviceId: string): Promise<void> {
        try {
            const existingMetrics = await this.redis.get(serviceId);
            let metrics: ServiceMetrics;

            if (existingMetrics) {
                metrics = JSON.parse(existingMetrics);
            } else {
                metrics = { ...this.metrics };
            }

            metrics.lastSelectedTime = Date.now();

            await this.redis.set(
                serviceId,
                JSON.stringify(metrics),
                "EX",
                24 * 60 * 60,
            );
        } catch (error) {
            console.warn(
                `Failed to update selection metrics for service ${serviceId}:`,
                error,
            );
        }
    }

    async getSelectionMetrics(serviceId: string): Promise<ServiceMetrics | null> {
        try {
            const metrics = await this.redis.get(serviceId);
            return metrics ? JSON.parse(metrics) : null;
        } catch (error) {
            console.error("Error getting service metrics:", error);
            return null;
        }
    }

    async refresh(): Promise<void> {
        try {
            const keys = await this.redis.keys(`${this.cachePrefix}:*`);
            if (keys.length > 0) {
                await this.redis.del(...keys);
            }
        } catch (error) {
            console.error("Error refreshing metrics:", error);
        }
    }
}

export default ConsulResolver;
