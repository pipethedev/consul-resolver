import { log } from "@brimble/utils";
import Consul from "consul";
import Redis from "ioredis";
import { ServiceHealth } from "../types";

export class HealthCheckManager {
    constructor(
        private consul: Consul,
        private redis: Redis | undefined,
        private cachePrefix: string,
        private cacheTTL: number,
        private cacheEnabled: boolean,
        private debug: boolean
    ) {}

    private getHealthCacheKey(service: string): string {
        return `${this.cachePrefix}:health:${service}`;
    }

    async getHealthChecks(service: string): Promise<ServiceHealth[]> {
        const cacheKey = this.getHealthCacheKey(service);

        if (this.cacheEnabled) {
            const cachedHealth = await this.redis?.get(cacheKey);
            if (cachedHealth) {
                return JSON.parse(cachedHealth);
            }
        }

        try {
            const healthChecks = await this.consul.health.service(service);

            if (this.cacheEnabled) {
                await this.redis?.set(
                    cacheKey,
                    JSON.stringify(healthChecks),
                    'EX',
                    this.cacheTTL
                );
            }

            return healthChecks;
        } catch (error) {
            if (this.debug) {
                log.error(`Error fetching health checks for ${service}:`, error);
            }
            return [];
        }
    }
}
