# consul-resolver

A simple load balancer for Consul services with Redis-based metrics tracking. 
This package provides multiple load balancing algorithms, such as Round Robin, Least Connection, and Weighted Round Robin.

## Features

- Multiple load balancing algorithms:
  - Round Robin
  - Least Connection
  - Weighted Round Robin
- Real-time connection tracking
- Health check integration
- Redis-based metrics storage
- Service metrics monitoring

## Installation

```bash
npm install consul-resolver
```

## Prerequisites

- Node.js >= 14
- Redis server
- Consul server

## Quick Start

```typescript
import { ConsulResolver, SelectionAlgorithm } from 'consul-resolver';
import Redis from 'ioredis';
import https from 'https';

const redis = new Redis({
  host: 'localhost',
  port: 6379
});

const resolver = new ConsulResolver({
  redis,
  host: "consul.example.com",
  port: 443,
  secure: true,
  token: process.env.CONSUL_TOKEN,
  agent: new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
  })
});

const service = await resolver.selectOptimalService(
  "my-service", 
  SelectionAlgorithm.LeastConnection
);

await resolver.incrementConnections(service.selected.id);

await resolver.decrementConnections(service.selected.id);
```


## Configuration

The ConsulResolver constructor accepts the following configuration options:

```typescript
interface ConsulResolverConfig {
  redis: Redis;           // Redis instance
  host: string;          // Consul host
  port: number;          // Consul port
  secure: boolean;       // Use HTTPS
  token?: string;        // Consul ACL token
  agent?: Agent;         // Optional HTTPS agent configuration
}
```
## API Reference

### `selectOptimalService(service: string, algorithm?: SelectionAlgorithm): Promise<OptimalService | null>`
Selects the optimal service instance based on the specified algorithm.

### `getSelectionMetrics(serviceId: string): Promise<ServiceMetrics | null>`
Retrieves current metrics for a specific service.

### `incrementConnections(serviceId: string): Promise<void>`
Increments the active connection count for a service.

### `decrementConnections(serviceId: string): Promise<void>`
Decrements the active connection count for a service.

### `refresh(): Promise<void>`
Clears all stored metrics from Redis.

## Types

### OptimalService
```typescript
interface OptimalService {
  selected: {
    ip: string;
    port: number;
  };
  services: Array<{
    ip: string;
    port: number;
  }>;
}
```

### ServiceMetrics
```typescript
interface ServiceMetrics {
  responseTime: number;
  errorRate: number;
  cpuUsage: number;
  memoryUsage: number;
  activeConnections: number;
  lastSelectedTime?: number;
}
```

## Usage with Express

```typescript
import express from 'express';
import { ConsulResolver, SelectionAlgorithm } from 'consul-resolver';

const app = express();
const resolver = new ConsulResolver(config);

app.use(async (req, res, next) => {
  const service = await resolver.selectOptimalService('api-service');
  if (!service) {
    return res.status(503).json({ error: 'No service available' });
  }

  await resolver.incrementConnections(service.selected.id);

  req.serviceInfo = service.selected;
  
  res.on('close', async () => {
    await resolver.decrementConnections(service.selected.id);
  });

  next();
});
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Author

Muritala David