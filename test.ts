import Redis from "ioredis";
import { ConsulResolver } from "./src";

const resolver = new ConsulResolver({
    redis: new Redis({ host: 'localhost', port: 6379 }),
    cachePrefix: "consul",
    host: "157.90.225.125",
    port: 8500,
    secure: false,
    token: "ac19549e-48fb-faf7-638c-033d1a9a5820",
});

(async () => {
    const result = await resolver.selectOptimalService("promtail");
    console.log(result);
})();