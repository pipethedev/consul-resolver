# consul-resolver

A simple consul library for load balancing and metrics tracking with redis.
This package provides multiple load balancing algorithms, such as Round Robin, Least Connection, and Weighted Round Robin.

## Features

- Multiple load balancing algorithms:
  - Round Robin
  - Least Connection
  - Weighted Round Robin
- Consul Integration

## Installation

```bash
yarn add consul-resolver
```

```bash
npm install consul-resolver
```

## Prerequisites

- Node.js >= 14
- Redis server
- Consul server

## Quick Start

```typescript
import { ConsulResolver, SelectionAlgorithm } from "consul-resolver";
import Redis from "ioredis";
import https from "https";

const redis = new Redis({
  host: "localhost",
  port: 6379,
});

const resolver = new ConsulResolver({
  redis,
  host: "127.0.0.1",
  port: 8500,
  secure: false,
  cachePrefix: "mydb",
  token: process.env.CONSUL_TOKEN,
  agent: new https.Agent({
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
  }),
});

const service = await resolver.selectOptimalService(
  "my-service",
  SelectionAlgorithm.LeastConnection,
);

await resolver.incrementConnections(service.selected.id);

await resolver.decrementConnections(service.selected.id);
```

## Configuration

The ConsulResolver constructor accepts the following configuration options:

```typescript
interface ConsulResolverConfig {
  cachePrefix: string; // Prefix for Redis cache keys
  redis: Redis; // Redis instance
  host: string; // Consul host
  port: number; // Consul port
  secure: boolean; // Use HTTPS
  token?: string; // Consul ACL token
  agent?: Agent; // Optional HTTPS agent configuration
  weights?: {
    health: number;
    responseTime: number;
    errorRate: number;
    resources: number;
    connections: number;
    distribution: number;
  }; // Custom weights for the weighted round robin algorithm
  metrics?: {
    responseTime: number;
    errorRate: number;
    cpuUsage: number;
    memoryUsage: number;
    activeConnections: number;
  }; // Custom metrics for the weighted round robin algorithm
}
```

## API Reference

### `selectOptimalService(service: string, algorithm?: SelectionAlgorithm): Promise<OptimalServiceResult | null>`

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

### OptimalServiceResult

```typescript
interface OptimalServiceResult {
  selected: {
    ip: string;
    port: number;
  } | null;
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

# Service Selection Weights and Metrics

## Selection Weights

The Weighted Round Robin algorithm uses the following weight distribution to calculate service scores:

```typescript
const DEFAULT_WEIGHTS = {
  health: 0.25, // Service health status (25%)
  responseTime: 0.2, // Response time performance (20%)
  errorRate: 0.2, // Error rate of the service (20%)
  resources: 0.15, // CPU and memory usage (15%)
  connections: 0.1, // Active connection count (10%)
  distribution: 0.1, // Time since last selection (10%)
};
```

### Weight Explanations

- **health (25%)**: Prioritizes services with passing health checks

  - Calculated as ratio of passing checks to total checks
  - Most heavily weighted as service health is critical

- **responseTime (20%)**: Favors services with lower response times

  - Normalized against a 500ms baseline
  - Higher weight indicates better performance

- **errorRate (20%)**: Considers service reliability

  - Normalized against a 100% scale
  - Lower error rates result in higher scores

- **resources (15%)**: Accounts for service load

  - Combines CPU and memory utilization
  - Prevents overloading of busy instances

- **connections (10%)**: Active connection count

  - Helps distribute load across instances
  - Prevents any single instance from being overwhelmed

- **distribution (10%)**: Time since last selection
  - Ensures fair rotation among services
  - Prevents "hot spot" instances

## Default Metrics

Each service starts with these default metrics if no historical data is available:

```typescript
const DEFAULT_METRICS = {
  responseTime: 100, // Default 100ms response time
  errorRate: 0, // Start with 0% error rate
  cpuUsage: 50, // Assume 50% CPU usage
  memoryUsage: 50, // Assume 50% memory usage
  activeConnections: 0, // Start with no active connections
};
```

### Metrics Explanation

- **responseTime**: Initial 100ms baseline

  - Conservative default for new services
  - Updated based on actual performance

- **errorRate**: Starts at 0%

  - Optimistic initial error rate
  - Adjusted based on actual failures

- **cpuUsage**: Default 50%

  - Moderate initial CPU load assumption
  - Updated with actual metrics when available

- **memoryUsage**: Default 50%

  - Moderate initial memory usage assumption
  - Updated with actual metrics when available

- **activeConnections**: Starts at 0
  - Fresh services begin with no connections
  - Incremented/decremented as connections are established/closed

## Usage with Express (Best used as a middleware)

```typescript
import express from "express";
import { ConsulResolver, SelectionAlgorithm } from "consul-resolver";

const app = express();
const resolver = new ConsulResolver(config);

app.use(async (req, res, next) => {
  const service = await resolver.selectOptimalService("api-service");
  if (!service) {
    return res.status(503).json({ error: "No service available" });
  }

  await resolver.incrementConnections(service.selected.id);

  req.serviceInfo = service.selected;

  res.on("close", async () => {
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

Muritala David Ilerioluwa
