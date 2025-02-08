"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_METRICS = exports.DEFAULT_WEIGHTS = exports.SelectionAlgorithm = void 0;
var SelectionAlgorithm;
(function (SelectionAlgorithm) {
    SelectionAlgorithm["RoundRobin"] = "round-robin";
    SelectionAlgorithm["LeastConnection"] = "least-connection";
    SelectionAlgorithm["WeightedRoundRobin"] = "weighted-round-robin";
})(SelectionAlgorithm = exports.SelectionAlgorithm || (exports.SelectionAlgorithm = {}));
exports.DEFAULT_WEIGHTS = {
    health: 0.25,
    responseTime: 0.2,
    errorRate: 0.2,
    resources: 0.15,
    connections: 0.1,
    distribution: 0.1,
};
exports.DEFAULT_METRICS = {
    responseTime: 100,
    errorRate: 0,
    cpuUsage: 50,
    memoryUsage: 50,
    activeConnections: 0,
};
