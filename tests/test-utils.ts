import { ServiceHealth } from '../src/types';

export function createMockService(
    id: string,
    address: string,
    port: number = 8080,
    checkStatus: string = 'passing'
): ServiceHealth {
    return {
        Node: {
            Node: `node-${id}`,
            Address: address,
        },
        Service: {
            ID: id,
            Service: 'api',
            Tags: [],
            Address: address,
            Port: port,
        },
        Checks: [
            {
                Status: checkStatus,
                Output: '',
            },
        ],
    };
}

export function createMockServiceWithChecks(
    id: string,
    address: string,
    port: number = 8080,
    checkStatuses: string[] = ['passing']
): ServiceHealth {
    return {
        Node: {
            Node: `node-${id}`,
            Address: address,
        },
        Service: {
            ID: id,
            Service: 'api',
            Tags: [],
            Address: address,
            Port: port,
        },
        Checks: checkStatuses.map((status) => ({
            Status: status,
            Output: '',
        })),
    };
}
