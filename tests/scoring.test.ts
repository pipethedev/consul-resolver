import {
    calculateDistributionScore,
    calculateHealthScore,
    calculateResourceScore,
    combineHealthAndDNSWeights,
    normalizeScore,
    rankServices,
} from '../src/scoring';
import { DEFAULT_METRICS, DEFAULT_WEIGHTS, ServiceMetrics } from '../src/types';
import { createMockService, createMockServiceWithChecks } from './test-utils';

describe('Scoring Tests', () => {
    describe('calculateHealthScore', () => {
        it('should return 1.0 when all checks are passing', () => {
            const service = createMockServiceWithChecks('service-1', '192.168.1.1', 8080, ['passing', 'passing']);

            expect(calculateHealthScore(service)).toBe(1.0);
        });

        it('should return 0.5 when half of checks are passing', () => {
            const service = createMockServiceWithChecks('service-1', '192.168.1.1', 8080, ['passing', 'critical']);

            expect(calculateHealthScore(service)).toBe(0.5);
        });

        it('should return 0 when no checks are available', () => {
            const service = createMockServiceWithChecks('service-1', '192.168.1.1', 8080, []);

            expect(calculateHealthScore(service)).toBe(0);
        });

        it('should return 0 when all checks are failing', () => {
            const service = createMockServiceWithChecks('service-1', '192.168.1.1', 8080, ['critical', 'warning']);

            expect(calculateHealthScore(service)).toBe(0);
        });
    });

    describe('calculateResourceScore', () => {
        it('should return 1.0 when resources are at 0%', () => {
            const metrics: ServiceMetrics = {
                ...DEFAULT_METRICS,
                cpuUsage: 0,
                memoryUsage: 0,
            };

            expect(calculateResourceScore(metrics)).toBe(1.0);
        });

        it('should return 0.0 when resources are at 100%', () => {
            const metrics: ServiceMetrics = {
                ...DEFAULT_METRICS,
                cpuUsage: 100,
                memoryUsage: 100,
            };

            expect(calculateResourceScore(metrics)).toBe(0.0);
        });

        it('should return 0.5 when resources are at 50%', () => {
            const metrics: ServiceMetrics = {
                ...DEFAULT_METRICS,
                cpuUsage: 50,
                memoryUsage: 50,
            };

            expect(calculateResourceScore(metrics)).toBe(0.5);
        });

        it('should average CPU and memory scores', () => {
            const metrics: ServiceMetrics = {
                ...DEFAULT_METRICS,
                cpuUsage: 0,
                memoryUsage: 100,
            };

            expect(calculateResourceScore(metrics)).toBe(0.5);
        });
    });

    describe('calculateDistributionScore', () => {
        it('should return 1.0 when no last selected time', () => {
            expect(calculateDistributionScore()).toBe(1.0);
        });

        it('should return 1.0 when last selected > 5 minutes ago', () => {
            const fiveMinutesAgo = Date.now() - (6 * 60 * 1000);
            expect(calculateDistributionScore(fiveMinutesAgo)).toBe(1.0);
        });

        it('should return 0.5 when last selected 2.5 minutes ago', () => {
            const twoAndHalfMinutesAgo = Date.now() - (2.5 * 60 * 1000);
            const score = calculateDistributionScore(twoAndHalfMinutesAgo);
            expect(score).toBeCloseTo(0.5, 1);
        });

        it('should return close to 0 when just selected', () => {
            const justNow = Date.now();
            const score = calculateDistributionScore(justNow);
            expect(score).toBeLessThan(0.1);
        });
    });

    describe('normalizeScore', () => {
        it('should normalize values within range', () => {
            expect(normalizeScore(50, 100)).toBe(0.5);
            expect(normalizeScore(25, 100)).toBe(0.25);
            expect(normalizeScore(75, 100)).toBe(0.75);
        });

        it('should clamp values above max to 1.0', () => {
            expect(normalizeScore(150, 100)).toBe(1.0);
        });

        it('should clamp values below 0 to 0', () => {
            expect(normalizeScore(-10, 100)).toBe(0);
        });

        it('should inverse when inverse=true', () => {
            expect(normalizeScore(50, 100, true)).toBe(0.5);
            expect(normalizeScore(0, 100, true)).toBe(1.0);
            expect(normalizeScore(100, 100, true)).toBe(0.0);
        });
    });

    describe('rankServices', () => {
        const mockServices = [
            createMockService('service-1', '192.168.1.1'),
            createMockService('service-2', '192.168.1.2'),
        ];

        it('should rank services based on composite score', () => {
            const metrics = new Map<string, ServiceMetrics>([
                ['service-1', { ...DEFAULT_METRICS, responseTime: 50, errorRate: 0, activeConnections: 5 }],
                ['service-2', { ...DEFAULT_METRICS, responseTime: 200, errorRate: 10, activeConnections: 20 }],
            ]);

            const ranked = rankServices(mockServices, metrics, DEFAULT_WEIGHTS);

            expect(ranked.length).toBe(2);
            expect(ranked[0].id).toBe('service-1');
            expect(ranked[1].id).toBe('service-2');
            expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
        });

        it('should sort services from highest to lowest score', () => {
            const metrics = new Map<string, ServiceMetrics>([
                ['service-1', { ...DEFAULT_METRICS, responseTime: 100 }],
                ['service-2', { ...DEFAULT_METRICS, responseTime: 50 }],
            ]);

            const ranked = rankServices(mockServices, metrics, DEFAULT_WEIGHTS);

            expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
        });

        it('should throw error when metrics not found for service', () => {
            const metrics = new Map<string, ServiceMetrics>([
                ['service-1', { ...DEFAULT_METRICS }],
            ]);

            expect(() => rankServices(mockServices, metrics, DEFAULT_WEIGHTS)).toThrow(
                'No metrics found for service service-2'
            );
        });

        it('should apply custom weights correctly', () => {
            const customWeights = {
                health: 1.0,
                responseTime: 0,
                errorRate: 0,
                resources: 0,
                connections: 0,
                distribution: 0,
            };

            const metrics = new Map<string, ServiceMetrics>([
                ['service-1', { ...DEFAULT_METRICS }],
                ['service-2', { ...DEFAULT_METRICS }],
            ]);

            const mockServicesWithDifferentHealth = [
                createMockServiceWithChecks('service-1', '192.168.1.1', 8080, ['passing', 'passing']),
                createMockServiceWithChecks('service-2', '192.168.1.2', 8080, ['passing']),
            ];

            const ranked = rankServices(mockServicesWithDifferentHealth, metrics, customWeights);

            expect(ranked[0].id).toBe('service-1');
        });
    });

    describe('combineHealthAndDNSWeights', () => {
        const mockService = createMockService('service-1', '192.168.1.1');

        it('should combine health and DNS weights with 70/30 ratio', () => {
            const result = combineHealthAndDNSWeights(mockService, 10, 10);

            expect(result).toBeCloseTo(1.0, 2);
        });

        it('should weight health more heavily (70%)', () => {
            const unhealthyService = createMockService('service-1', '192.168.1.1', 8080, 'critical');

            const result = combineHealthAndDNSWeights(unhealthyService, 10, 10);

            expect(result).toBeLessThan(0.5);
        });

        it('should normalize DNS weight', () => {
            const result1 = combineHealthAndDNSWeights(mockService, 5, 10);
            const result2 = combineHealthAndDNSWeights(mockService, 10, 10);

            expect(result2).toBeGreaterThan(result1);
        });
    });
});
