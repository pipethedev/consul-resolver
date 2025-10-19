import { log } from "@brimble/utils";
import Redis from "ioredis";
import { DEFAULT_METRICS, ServiceHealth, ServiceMetrics } from "../types";

export class MetricsManager {
    constructor(
        private redis: Redis | undefined,
        private cachePrefix: string,
        private metrics: typeof DEFAULT_METRICS,
        private cacheEnabled: boolean,
        private debug: boolean
    ) {}

    private getConnectionKey(serviceId: string): string {
        return `${this.cachePrefix}:connections:${serviceId}`;
    }

    async getServicesMetrics(
        services: ServiceHealth[],
    ): Promise<Map<string, ServiceMetrics>> {
        const metricsMap = new Map<string, ServiceMetrics>();
        const pipeline = this.redis?.pipeline();

        if (this.cacheEnabled) {
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

                    if (connectionsResult?.[1]) {
                        const connData = JSON.parse(connectionsResult[1] as string);
                        metrics.activeConnections = connData.activeConnections || 0;
                    }

                    metricsMap.set(serviceId, metrics);
                } catch (error) {
                    if (this.debug) {
                        log.error(
                            `Error processing metrics for service ${serviceId}:`,
                            error,
                        );
                    }
                    metricsMap.set(serviceId, { ...this.metrics });
                }
            });
        } catch (error) {
            if (this.debug) {
                log.error("Error executing Redis pipeline:", error);
            }
            services.forEach((service) => {
                metricsMap.set(service.Service.ID, { ...this.metrics });
            });
        }

        return metricsMap;
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
            if (this.debug) {
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
            if (this.debug) {
                log.error(
                    `Failed to decrement connections for service ${serviceId}:`,
                    error,
                );
            }
        }
    }

    async updateSelectionMetrics(serviceId: string): Promise<void> {
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
            if (this.debug) {
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
            if (this.debug) {
                log.error("Error getting service metrics:", error);
            }
            return null;
        }
    }
}
