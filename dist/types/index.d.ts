/// <reference types="node" />
import Redis from "ioredis";
import { Agent } from "https";
export interface ConsulResolverConfig {
  redis: Redis;
  host: string;
  port: number;
  secure: boolean;
  token: string;
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
export declare enum SelectionAlgorithm {
  RoundRobin = "round-robin",
  LeastConnection = "least-connection",
  WeightedRoundRobin = "weighted-round-robin",
}
export declare const DEFAULT_WEIGHTS: {
  health: number;
  responseTime: number;
  errorRate: number;
  resources: number;
  connections: number;
  distribution: number;
};
export declare const DEFAULT_METRICS: ServiceMetrics;
