import {
  ConsulResolverConfig,
  ServiceMetrics,
  SelectionAlgorithm,
  OptimalServiceResult,
} from "./types";
declare class ConsulResolver {
  private config;
  private currentIndex;
  private consul;
  private redis;
  constructor(config: ConsulResolverConfig);
  selectOptimalService(
    service: string,
    algorithm?: SelectionAlgorithm,
  ): Promise<OptimalServiceResult>;
  private roundRobinSelection;
  private leastConnectionSelection;
  private getServicesMetrics;
  private rankServices;
  private calculateHealthScore;
  private calculateResourceScore;
  private calculateDistributionScore;
  private normalizeScore;
  private weightedRandomSelection;
  incrementConnections(serviceId: string): Promise<void>;
  decrementConnections(serviceId: string): Promise<void>;
  private updateSelectionMetrics;
  getSelectionMetrics(serviceId: string): Promise<ServiceMetrics | null>;
  refresh(): Promise<void>;
}
export default ConsulResolver;
