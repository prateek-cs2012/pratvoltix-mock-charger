export const config = {
  port: Number(process.env.PORT ?? 8080),
  mongodbUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/pratvoltix",
  publicWsUrl: process.env.PUBLIC_WS_URL ?? "ws://localhost:8080/ocpp",
  targetCsmsUrl: process.env.TARGET_CSMS_URL,
  heartbeatInterval: Number(process.env.HEARTBEAT_INTERVAL ?? 60),
};
