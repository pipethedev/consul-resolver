import {
    leastConnectionSelection,
    roundRobinSelection,
    roundRobinSrvSelection,
    weightedRandomSelection,
    weightedSrvRecordSelection,
} from '../src/algorithms';
import { DEFAULT_METRICS, ServiceMetrics, SrvRecord } from '../src/types';
import { createMockService } from './test-utils';

describe('Algorithm Tests', () => {
    describe('roundRobinSelection', () => {
        const mockServices = [
            createMockService('service-1', '192.168.1.1'),
            createMockService('service-2', '192.168.1.2'),
            createMockService('service-3', '192.168.1.3'),
        ];

        it('should select services in round-robin order', () => {
            const result1 = roundRobinSelection(mockServices, 0);
            expect(result1.id).toBe('service-1');
            expect(result1.nextIndex).toBe(1);

            const result2 = roundRobinSelection(mockServices, result1.nextIndex);
            expect(result2.id).toBe('service-2');
            expect(result2.nextIndex).toBe(2);

            const result3 = roundRobinSelection(mockServices, result2.nextIndex);
            expect(result3.id).toBe('service-3');
            expect(result3.nextIndex).toBe(0);
        });

        it('should wrap around to the first service', () => {
            const result = roundRobinSelection(mockServices, 3);
            expect(result.id).toBe('service-1');
            expect(result.nextIndex).toBe(1);
        });

        it('should throw error when no healthy services available', () => {
            const unhealthyServices = [createMockService('service-1', '192.168.1.1', 8080, 'critical')];

            expect(() => roundRobinSelection(unhealthyServices, 0)).toThrow('No healthy services available');
        });

        it('should filter out unhealthy services', () => {
            const mixedServices = [
                ...mockServices,
                createMockService('service-4', '192.168.1.4', 8080, 'critical'),
            ];

            const result1 = roundRobinSelection(mixedServices, 0);
            const result2 = roundRobinSelection(mixedServices, result1.nextIndex);
            const result3 = roundRobinSelection(mixedServices, result2.nextIndex);

            expect([result1.id, result2.id, result3.id]).not.toContain('service-4');
        });
    });

    describe('leastConnectionSelection', () => {
        const mockServices = [
            createMockService('service-1', '192.168.1.1'),
            createMockService('service-2', '192.168.1.2'),
            createMockService('service-3', '192.168.1.3'),
        ];

        it('should select service with least connections', () => {
            const metrics = new Map<string, ServiceMetrics>([
                ['service-1', { ...DEFAULT_METRICS, activeConnections: 5 }],
                ['service-2', { ...DEFAULT_METRICS, activeConnections: 2 }],
                ['service-3', { ...DEFAULT_METRICS, activeConnections: 10 }],
            ]);

            const result = leastConnectionSelection(mockServices, metrics, DEFAULT_METRICS);
            expect(result.id).toBe('service-2');
        });

        it('should use default metrics when service metrics not found', () => {
            const metrics = new Map<string, ServiceMetrics>([
                ['service-1', { ...DEFAULT_METRICS, activeConnections: 5 }],
            ]);

            const result = leastConnectionSelection(mockServices, metrics, DEFAULT_METRICS);
            expect(result.id).toBe('service-2');
        });

        it('should throw error when no healthy services available', () => {
            const unhealthyServices = [createMockService('service-1', '192.168.1.1', 8080, 'critical')];

            expect(() => leastConnectionSelection(unhealthyServices, new Map(), DEFAULT_METRICS)).toThrow(
                'No healthy services available'
            );
        });
    });

    describe('weightedRandomSelection', () => {
        const mockRankedServices = [
            {
                score: 0.8,
                id: 'service-1',
                service: createMockService('service-1', '192.168.1.1'),
            },
            {
                score: 0.5,
                id: 'service-2',
                service: createMockService('service-2', '192.168.1.2'),
            },
        ];

        it('should select a service based on weighted random', () => {
            const result = weightedRandomSelection(mockRankedServices);
            expect(['service-1', 'service-2']).toContain(result.id);
        });

        it('should return first service when total score is 0', () => {
            const zeroScoreServices = [
                { ...mockRankedServices[0], score: 0 },
                { ...mockRankedServices[1], score: 0 },
            ];

            const result = weightedRandomSelection(zeroScoreServices);
            expect(result.id).toBe('service-1');
        });

        it('should throw error when no services available', () => {
            expect(() => weightedRandomSelection([])).toThrow('No services available for selection');
        });

        it('should favor higher scored services', () => {
            const highScoreServices = [
                { ...mockRankedServices[0], score: 100 },
                { ...mockRankedServices[1], score: 1 },
            ];

            const selections: string[] = [];
            for (let i = 0; i < 100; i++) {
                const result = weightedRandomSelection(highScoreServices);
                selections.push(result.id);
            }

            const service1Count = selections.filter(id => id === 'service-1').length;
            expect(service1Count).toBeGreaterThan(50);
        });
    });

    describe('roundRobinSrvSelection', () => {
        const mockRecords: SrvRecord[] = [
            { name: 'srv1.example.com', ip: '192.168.1.1', port: 8080, priority: 10, weight: 5 },
            { name: 'srv2.example.com', ip: '192.168.1.2', port: 8080, priority: 10, weight: 5 },
            { name: 'srv3.example.com', ip: '192.168.1.3', port: 8080, priority: 10, weight: 5 },
        ];

        it('should select records in round-robin order', () => {
            const result1 = roundRobinSrvSelection(mockRecords, 0);
            expect(result1?.selected.ip).toBe('192.168.1.1');
            expect(result1?.nextIndex).toBe(1);

            const result2 = roundRobinSrvSelection(mockRecords, result1!.nextIndex);
            expect(result2?.selected.ip).toBe('192.168.1.2');
            expect(result2?.nextIndex).toBe(2);
        });

        it('should return null for empty records', () => {
            const result = roundRobinSrvSelection([], 0);
            expect(result).toBeNull();
        });

        it('should wrap around to first record', () => {
            const result = roundRobinSrvSelection(mockRecords, 3);
            expect(result?.selected.ip).toBe('192.168.1.1');
        });
    });

    describe('weightedSrvRecordSelection', () => {
        const mockRecords: SrvRecord[] = [
            { name: 'srv1.example.com', ip: '192.168.1.1', port: 8080, priority: 10, weight: 10 },
            { name: 'srv2.example.com', ip: '192.168.1.2', port: 8080, priority: 10, weight: 5 },
            { name: 'srv3.example.com', ip: '192.168.1.3', port: 8080, priority: 10, weight: 1 },
        ];

        it('should select records based on weight', () => {
            const result = weightedSrvRecordSelection(mockRecords, 0);
            expect(result).not.toBeNull();
            expect(['192.168.1.1', '192.168.1.2', '192.168.1.3']).toContain(result?.selected.ip);
        });

        it('should fall back to round-robin when all weights are 0', () => {
            const zeroWeightRecords: SrvRecord[] = [
                { name: 'srv1.example.com', ip: '192.168.1.1', port: 8080, priority: 10, weight: 0 },
                { name: 'srv2.example.com', ip: '192.168.1.2', port: 8080, priority: 10, weight: 0 },
            ];

            const result = weightedSrvRecordSelection(zeroWeightRecords, 0);
            expect(result?.selected.ip).toBe('192.168.1.1');
            expect(result?.nextIndex).toBe(1);
        });

        it('should return null for empty records', () => {
            const result = weightedSrvRecordSelection([], 0);
            expect(result).toBeNull();
        });
    });
});
