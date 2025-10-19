import { DEFAULT_WEIGHTS, ServiceHealth, ServiceMetrics } from "../types";

export function calculateHealthScore(service: ServiceHealth): number {
    const checks = service.Checks;
    const totalChecks = checks.length;
    if (totalChecks === 0) return 0;

    const passingChecks = checks.filter(
        (check) => check.Status === "passing",
    ).length;
    return passingChecks / totalChecks;
}

export function calculateResourceScore(metrics: ServiceMetrics): number {
    const cpuScore = normalizeScore(metrics.cpuUsage, 100, true);
    const memoryScore = normalizeScore(metrics.memoryUsage, 100, true);
    return (cpuScore + memoryScore) / 2;
}

export function calculateDistributionScore(lastSelectedTime?: number): number {
    if (!lastSelectedTime) return 1;

    const timeSinceLastSelection = Date.now() - lastSelectedTime;

    return Math.min(timeSinceLastSelection / (5 * 60 * 1000), 1);
}

export function normalizeScore(value: number, max: number, inverse = false): number {
    const normalized = Math.max(0, Math.min(1, value / max));
    return inverse ? 1 - normalized : normalized;
}

export function rankServices(
    services: ServiceHealth[],
    metrics: Map<string, ServiceMetrics>,
    weights: typeof DEFAULT_WEIGHTS = DEFAULT_WEIGHTS
): Array<{ score: number; id: string; service: ServiceHealth }> {
    return services
        .map((service) => {
            const serviceId = service.Service.ID;

            const serviceMetrics = metrics.get(serviceId);

            if (!serviceMetrics) {
                throw new Error(`No metrics found for service ${serviceId}`);
            }

            const healthScore = calculateHealthScore(service);
            const responseTimeScore = normalizeScore(
                serviceMetrics.responseTime,
                500,
                true,
            );
            const errorRateScore = normalizeScore(
                serviceMetrics.errorRate,
                100,
                true,
            );
            const resourceScore = calculateResourceScore(serviceMetrics);
            const connectionScore = normalizeScore(
                serviceMetrics.activeConnections,
                1000,
                true,
            );
            const distributionScore = calculateDistributionScore(
                serviceMetrics.lastSelectedTime,
            );

            const totalScore =
                healthScore * weights.health +
                responseTimeScore * weights.responseTime +
                errorRateScore * weights.errorRate +
                resourceScore * weights.resources +
                connectionScore * weights.connections +
                distributionScore * weights.distribution;

            return {
                score: totalScore,
                id: serviceId,
                service,
            };
        })
        .sort((a, b) => b.score - a.score);
}

export function combineHealthAndDNSWeights(
    service: ServiceHealth,
    dnsWeight: number,
    maxDNSWeight: number
): number {
    const healthScore = calculateHealthScore(service);
    const normalizedDNSWeight = dnsWeight / maxDNSWeight;
    return (healthScore * 0.7) + (normalizedDNSWeight * 0.3);
}
