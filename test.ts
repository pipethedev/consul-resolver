import Redis from "ioredis";
import { ConsulResolver } from "./src";

const resolver = new ConsulResolver({
  redis: new Redis(),
  cachePrefix: "consul",
  host: "localhost",
  port: 8500,
  secure: false,
  token: "",
});

resolver.refresh();
