import RedisMock from 'ioredis-mock';
import { MetricsManager } from '../src/metrics';
import { DEFAULT_METRICS } from '../src/types';
import { createMockService } from './test-utils';

describe('MetricsManager Tests', () => {
    let redis: any;
    let metricsManager: MetricsManager;

    beforeEach(() => {
        redis = new RedisMock();
        metricsManager = new MetricsManager(
            redis as any,
            'test-consul',
            DEFAULT_METRICS,
            true,
            false
        );
    });

    afterEach(async () => {
        await redis.flushall();
        redis.disconnect();
    });

    describe('incrementConnections', () => {
        it('should increment connections for a service', async () => {
            await metricsManager.incrementConnections('service-1');

            const metrics = await metricsManager.getSelectionMetrics('service-1');
            expect(metrics?.activeConnections).toBe(1);
        });

        it('should increment existing connections', async () => {
            await metricsManager.incrementConnections('service-1');
            await metricsManager.incrementConnections('service-1');
            await metricsManager.incrementConnections('service-1');

            const metrics = await metricsManager.getSelectionMetrics('service-1');
            expect(metrics?.activeConnections).toBe(3);
        });

        it('should handle multiple services independently', async () => {
            await metricsManager.incrementConnections('service-1');
            await metricsManager.incrementConnections('service-2');
            await metricsManager.incrementConnections('service-1');

            const metrics1 = await metricsManager.getSelectionMetrics('service-1');
            const metrics2 = await metricsManager.getSelectionMetrics('service-2');

            expect(metrics1?.activeConnections).toBe(2);
            expect(metrics2?.activeConnections).toBe(1);
        });
    });

    describe('decrementConnections', () => {
        it('should decrement connections for a service', async () => {
            await metricsManager.incrementConnections('service-1');
            await metricsManager.incrementConnections('service-1');
            await metricsManager.decrementConnections('service-1');

            const metrics = await metricsManager.getSelectionMetrics('service-1');
            expect(metrics?.activeConnections).toBe(1);
        });

        it('should not go below zero', async () => {
            await metricsManager.decrementConnections('service-1');
            await metricsManager.decrementConnections('service-1');

            const metrics = await metricsManager.getSelectionMetrics('service-1');
            expect(metrics?.activeConnections).toBe(0);
        });

        it('should handle decrementing non-existent service', async () => {
            await metricsManager.decrementConnections('non-existent');

            const metrics = await metricsManager.getSelectionMetrics('non-existent');
            expect(metrics?.activeConnections).toBe(0);
        });
    });

    describe('updateSelectionMetrics', () => {
        it('should update last selected time', async () => {
            const beforeTime = Date.now();
            await metricsManager.updateSelectionMetrics('service-1');
            const afterTime = Date.now();

            const metrics = await metricsManager.getSelectionMetrics('service-1');

            expect(metrics?.lastSelectedTime).toBeDefined();
            expect(metrics?.lastSelectedTime).toBeGreaterThanOrEqual(beforeTime);
            expect(metrics?.lastSelectedTime).toBeLessThanOrEqual(afterTime);
        });

        it('should preserve other metrics when updating selection time', async () => {
            await metricsManager.incrementConnections('service-1');
            await metricsManager.updateSelectionMetrics('service-1');

            const metrics = await metricsManager.getSelectionMetrics('service-1');

            expect(metrics?.activeConnections).toBe(1);
            expect(metrics?.lastSelectedTime).toBeDefined();
        });
    });

    describe('getServicesMetrics', () => {
        const mockServices = [
            createMockService('service-1', '192.168.1.1'),
            createMockService('service-2', '192.168.1.2'),
        ];

        it('should return default metrics when no data exists', async () => {
            const metricsMap = await metricsManager.getServicesMetrics(mockServices);

            expect(metricsMap.size).toBe(2);
            expect(metricsMap.get('service-1')).toEqual(DEFAULT_METRICS);
            expect(metricsMap.get('service-2')).toEqual(DEFAULT_METRICS);
        });

        it('should return stored metrics with connection counts', async () => {
            await metricsManager.incrementConnections('service-1');
            await metricsManager.incrementConnections('service-1');
            await metricsManager.incrementConnections('service-2');

            const metricsMap = await metricsManager.getServicesMetrics(mockServices);

            expect(metricsMap.get('service-1')?.activeConnections).toBe(2);
            expect(metricsMap.get('service-2')?.activeConnections).toBe(1);
        });

        it('should handle mixed scenarios with some services having metrics', async () => {
            await metricsManager.incrementConnections('service-1');

            const metricsMap = await metricsManager.getServicesMetrics(mockServices);

            expect(metricsMap.get('service-1')?.activeConnections).toBe(1);
            expect(metricsMap.get('service-2')?.activeConnections).toBe(0);
        });
    });

    describe('getSelectionMetrics', () => {
        it('should return null when no metrics exist', async () => {
            const metrics = await metricsManager.getSelectionMetrics('non-existent');
            expect(metrics).toBeNull();
        });

        it('should return stored metrics', async () => {
            await metricsManager.incrementConnections('service-1');
            await metricsManager.updateSelectionMetrics('service-1');

            const metrics = await metricsManager.getSelectionMetrics('service-1');

            expect(metrics).not.toBeNull();
            expect(metrics?.activeConnections).toBe(1);
            expect(metrics?.lastSelectedTime).toBeDefined();
        });
    });

    describe('cache disabled scenario', () => {
        it('should return null when cache is disabled', async () => {
            const disabledManager = new MetricsManager(
                redis as any,
                'test-consul',
                DEFAULT_METRICS,
                false,
                false
            );

            await disabledManager.incrementConnections('service-1');
            const metrics = await disabledManager.getSelectionMetrics('service-1');

            expect(metrics).toBeNull();
        });
    });
});
