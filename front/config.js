// 部署 Worker 后，把下面的地址换成 wrangler deploy 输出的 workers.dev 地址
// 这个地址是公开的，没有关系：没有登录令牌就读不到任何数据
window.RT_CONFIG = {
  workerUrl: "https://reward-tracker.YOUR_SUBDOMAIN.workers.dev",
};
