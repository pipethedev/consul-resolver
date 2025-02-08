import Redis from "ioredis";
import { Agent } from "https";

export interface ConsulResolverConfig {
  redis: Redis;
  cachePrefix: string;
  host: string;
  port: number;
  secure: boolean;
  token?: string;
  agent?: Agent | import("http").Agent;
}

export interface ServiceMetrics {
  responseTime: number;
  errorRate: number;
  cpuUsage: number;
  memoryUsage: number;
  activeConnections: number;
  lastSelectedTime?: number;
}

export interface ServiceHealth {
  Node: {
    Node: string;
    Address: string;
  };
  Service: {
    ID: string;
    Service: string;
    Tags: string[];
    Address: string;
    Port: number;
  };
  Checks: Array<{
    Status: string;
    Output: string;
  }>;
}

export interface ServiceInfo {
  ip: string;
  port: number;
}

export interface OptimalServiceResult {
  selected: ServiceInfo | null;
  services: ServiceInfo[];
}

export enum SelectionAlgorithm {
  RoundRobin = "round-robin",
  LeastConnection = "least-connection",
  WeightedRoundRobin = "weighted-round-robin",
}

export const DEFAULT_WEIGHTS = {
  health: 0.25,
  responseTime: 0.2,
  errorRate: 0.2,
  resources: 0.15,
  connections: 0.1,
  distribution: 0.1,
};

export const DEFAULT_METRICS: ServiceMetrics = {
  responseTime: 100,
  errorRate: 0,
  cpuUsage: 50,
  memoryUsage: 50,
  activeConnections: 0,
};
