"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const consul_1 = __importDefault(require("consul"));
const types_1 = require("./types");
class ConsulResolver {
    constructor(config) {
        this.config = config;
        this.currentIndex = 0;
        this.redis = config.redis;
        this.cachePrefix = config.cachePrefix;
        this.consul = new consul_1.default({
            host: config.host,
            port: config.port,
            secure: config.secure,
            defaults: {
                ...(config.token ? { token: config.token } : {}),
            },
            agent: config.agent,
        });
    }
    getConnectionKey(serviceId) {
        return `${this.cachePrefix}:connections:${serviceId}`;
    }
    async selectOptimalService(service, algorithm = types_1.SelectionAlgorithm.RoundRobin) {
        try {
            const healthChecks = await this.consul.health.service(service);
            if (!healthChecks || healthChecks.length === 0)
                return { selected: null, services: [] };
            const metrics = await this.getServicesMetrics(healthChecks);
            let selectedService;
            switch (algorithm) {
                case types_1.SelectionAlgorithm.RoundRobin:
                    selectedService = this.roundRobinSelection(healthChecks);
                    break;
                case types_1.SelectionAlgorithm.LeastConnection:
                    selectedService = this.leastConnectionSelection(healthChecks, metrics);
                    break;
                case types_1.SelectionAlgorithm.WeightedRoundRobin:
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
                services: healthChecks.map((check) => ({
                    ip: check.Service.Address,
                    port: check.Service.Port,
                })),
            };
        }
        catch (error) {
            console.error("Error selecting optimal service:", error);
            return { selected: null, services: [] };
        }
    }
    roundRobinSelection(services) {
        const healthyServices = services.filter((service) => service.Checks.every((check) => check.Status === "passing"));
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
    leastConnectionSelection(services, metrics) {
        const healthyServices = services
            .filter((service) => service.Checks.every((check) => check.Status === "passing"))
            .map((service) => {
            const serviceMetrics = metrics.get(service.Service.ID) || types_1.DEFAULT_METRICS;
            return {
                service,
                connections: serviceMetrics.activeConnections || 0,
            };
        });
        if (healthyServices.length === 0) {
            throw new Error("No healthy services available");
        }
        const selectedService = healthyServices.reduce((min, current) => current.connections < min.connections ? current : min);
        return {
            id: selectedService.service.Service.ID,
            service: selectedService.service,
        };
    }
    async getServicesMetrics(services) {
        const metricsMap = new Map();
        const pipeline = this.redis.pipeline();
        services.forEach((service) => {
            pipeline.get(service.Service.ID);
            pipeline.get(this.getConnectionKey(service.Service.ID));
        });
        try {
            const results = await pipeline.exec();
            if (!results) {
                services.forEach((service) => {
                    metricsMap.set(service.Service.ID, { ...types_1.DEFAULT_METRICS });
                });
                return metricsMap;
            }
            services.forEach((service, index) => {
                const serviceId = service.Service.ID;
                const metricsResult = results[index * 2];
                const connectionsResult = results[index * 2 + 1];
                let metrics;
                try {
                    if (metricsResult === null || metricsResult === void 0 ? void 0 : metricsResult[1]) {
                        metrics = JSON.parse(metricsResult[1]);
                    }
                    else {
                        metrics = { ...types_1.DEFAULT_METRICS };
                    }
                    const connections = (connectionsResult === null || connectionsResult === void 0 ? void 0 : connectionsResult[1])
                        ? parseInt(connectionsResult[1])
                        : 0;
                    metrics.activeConnections = connections;
                    metricsMap.set(serviceId, metrics);
                }
                catch (error) {
                    console.warn(`Error processing metrics for service ${serviceId}:`, error);
                    metricsMap.set(serviceId, { ...types_1.DEFAULT_METRICS });
                }
            });
        }
        catch (error) {
            console.error("Error executing Redis pipeline:", error);
            services.forEach((service) => {
                metricsMap.set(service.Service.ID, { ...types_1.DEFAULT_METRICS });
            });
        }
        return metricsMap;
    }
    async rankServices(services, metrics) {
        return services
            .map((service) => {
            const serviceId = service.Service.ID;
            const serviceMetrics = metrics.get(serviceId);
            if (!serviceMetrics)
                throw new Error(`No metrics found for service ${serviceId}`);
            const healthScore = this.calculateHealthScore(service);
            const responseTimeScore = this.normalizeScore(serviceMetrics.responseTime, 500, true);
            const errorRateScore = this.normalizeScore(serviceMetrics.errorRate, 100, true);
            const resourceScore = this.calculateResourceScore(serviceMetrics);
            const connectionScore = this.normalizeScore(serviceMetrics.activeConnections, 1000, true);
            const distributionScore = this.calculateDistributionScore(serviceMetrics.lastSelectedTime);
            const totalScore = healthScore * types_1.DEFAULT_WEIGHTS.health +
                responseTimeScore * types_1.DEFAULT_WEIGHTS.responseTime +
                errorRateScore * types_1.DEFAULT_WEIGHTS.errorRate +
                resourceScore * types_1.DEFAULT_WEIGHTS.resources +
                connectionScore * types_1.DEFAULT_WEIGHTS.connections +
                distributionScore * types_1.DEFAULT_WEIGHTS.distribution;
            return {
                score: totalScore,
                id: serviceId,
                service,
            };
        })
            .sort((a, b) => b.score - a.score);
    }
    calculateHealthScore(service) {
        const checks = service.Checks;
        const totalChecks = checks.length;
        const passingChecks = checks.filter((check) => check.Status === "passing").length;
        return passingChecks / totalChecks;
    }
    calculateResourceScore(metrics) {
        const cpuScore = this.normalizeScore(metrics.cpuUsage, 100, true);
        const memoryScore = this.normalizeScore(metrics.memoryUsage, 100, true);
        return (cpuScore + memoryScore) / 2;
    }
    calculateDistributionScore(lastSelectedTime) {
        if (!lastSelectedTime)
            return 1;
        const timeSinceLastSelection = Date.now() - lastSelectedTime;
        return Math.min(timeSinceLastSelection / (5 * 60 * 1000), 1);
    }
    normalizeScore(value, max, inverse = false) {
        const normalized = Math.max(0, Math.min(1, value / max));
        return inverse ? 1 - normalized : normalized;
    }
    weightedRandomSelection(rankedServices) {
        const totalScore = rankedServices.reduce((sum, service) => sum + service.score, 0);
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
    async incrementConnections(serviceId) {
        try {
            const connectionKey = this.getConnectionKey(serviceId);
            const existingMetrics = await this.redis.get(connectionKey);
            let metrics;
            if (existingMetrics) {
                metrics = JSON.parse(existingMetrics);
                metrics.activeConnections = (metrics.activeConnections || 0) + 1;
            }
            else {
                metrics = {
                    ...types_1.DEFAULT_METRICS,
                    activeConnections: 1,
                };
            }
            await this.redis.set(connectionKey, JSON.stringify(metrics), "EX", 24 * 60 * 60);
        }
        catch (error) {
            console.warn(`Failed to increment connections for service ${serviceId}:`, error);
        }
    }
    async decrementConnections(serviceId) {
        try {
            const connectionKey = this.getConnectionKey(serviceId);
            const existingMetrics = await this.redis.get(connectionKey);
            let metrics;
            if (existingMetrics) {
                metrics = JSON.parse(existingMetrics);
                metrics.activeConnections = Math.max(0, (metrics.activeConnections || 1) - 1);
            }
            else {
                metrics = {
                    ...types_1.DEFAULT_METRICS,
                    activeConnections: 0,
                };
            }
            await this.redis.set(connectionKey, JSON.stringify(metrics), "EX", 24 * 60 * 60);
        }
        catch (error) {
            console.warn(`Failed to decrement connections for service ${serviceId}:`, error);
        }
    }
    async updateSelectionMetrics(serviceId) {
        try {
            const defaultMetrics = {
                responseTime: 100,
                errorRate: 0,
                cpuUsage: 50,
                memoryUsage: 50,
                activeConnections: 0,
            };
            const existingMetrics = await this.redis.get(serviceId);
            let metrics;
            if (existingMetrics) {
                metrics = JSON.parse(existingMetrics);
            }
            else {
                metrics = { ...defaultMetrics };
            }
            metrics.lastSelectedTime = Date.now();
            await this.redis.set(serviceId, JSON.stringify(metrics), "EX", 24 * 60 * 60);
        }
        catch (error) {
            console.warn(`Failed to update selection metrics for service ${serviceId}:`, error);
        }
    }
    async getSelectionMetrics(serviceId) {
        try {
            const metrics = await this.redis.get(serviceId);
            return metrics ? JSON.parse(metrics) : null;
        }
        catch (error) {
            console.error("Error getting service metrics:", error);
            return null;
        }
    }
    async refresh() {
        try {
            const keys = await this.redis.keys(`${this.cachePrefix}:*`);
            if (keys.length > 0) {
                await this.redis.del(...keys);
            }
        }
        catch (error) {
            console.error("Error refreshing metrics:", error);
        }
    }
}
exports.default = ConsulResolver;
