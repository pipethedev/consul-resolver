import { ServiceHealth, ServiceMetrics, SrvRecord } from "../types";

export function roundRobinSelection(
    services: ServiceHealth[],
    currentIndex: number
): { id: string; service: ServiceHealth; nextIndex: number } {
    const healthyServices = services.filter((service) =>
        service.Checks.every((check) => check.Status === "passing"),
    );

    if (healthyServices.length === 0) {
        throw new Error("No healthy services available");
    }

    const service = healthyServices[currentIndex % healthyServices.length];
    const nextIndex = (currentIndex + 1) % healthyServices.length;

    return {
        id: service.Service.ID,
        service,
        nextIndex,
    };
}

export function leastConnectionSelection(
    services: ServiceHealth[],
    metrics: Map<string, ServiceMetrics>,
    defaultMetrics: ServiceMetrics
): { id: string; service: ServiceHealth } {
    const healthyServices = services
        .filter((service) =>
            service.Checks.every((check) => check.Status === "passing"),
        )
        .map((service) => {
            const serviceMetrics = metrics.get(service.Service.ID) || defaultMetrics;
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

export function weightedRandomSelection(
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

export function roundRobinSrvSelection(
    records: SrvRecord[],
    currentIndex: number
): { selected: SrvRecord; nextIndex: number } | null {
    if (!records || records.length === 0) {
        return null;
    }

    const selected = records[currentIndex % records.length];
    const nextIndex = (currentIndex + 1) % records.length;

    return { selected, nextIndex };
}

export function weightedSrvRecordSelection(
    records: SrvRecord[],
    currentIndex: number
): { selected: SrvRecord; nextIndex: number } | null {
    if (!records || records.length === 0) {
        return null;
    }

    const hasNonZeroWeights = records.some(record => (record.weight || 0) > 0);

    if (!hasNonZeroWeights) {
        return roundRobinSrvSelection(records, currentIndex);
    }

    const totalWeight = records.reduce((sum, record) => sum + (record.weight || 1), 0);

    let random = Math.random() * totalWeight;

    for (const record of records) {
        random -= (record.weight || 1);
        if (random <= 0) {
            return { selected: record, nextIndex: currentIndex };
        }
    }

    return { selected: records[0], nextIndex: currentIndex };
}
