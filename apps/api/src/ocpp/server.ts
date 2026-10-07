import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Server } from "node:http";
import { OcppConnection, transportFromWebSocket } from "@pratvoltix/ocpp";
import { CONTROL_PATH } from "@pratvoltix/simulator-control";
import { WebSocketServer } from "ws";
import { ChargePointModel } from "../models/charge-point.js";
import { handleChargePointCall, recordInbound } from "./charge-point-handler.js";
import { SessionRegistry } from "./registry.js";

const identityPattern = /^\/ocpp\/([A-Za-z0-9_-]{1,48})$/;

export function attachOcppServer(server: Server, registry: SessionRegistry): void {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("ocpp1.6") ? "ocpp1.6" : false),
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (request.url ?? "").split("?")[0];
    if (path === CONTROL_PATH) {
      return;
    }
    const identity = identityPattern.exec(path)?.[1];
    if (!identity) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const offered = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    if (!offered.includes("ocpp1.6")) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = new OcppConnection(transportFromWebSocket(ws), {
        onProtocolError: (error) => console.error(`[ocpp:${identity}] ${error.message}`),
        onInbound: (message) => {
          void recordInbound(identity, message).catch((error: unknown) => console.error(error));
        },
      });
      const session = { identity, connection, transactionCounter: 0 };
      connection.onCall((call) => handleChargePointCall(session, call));
      registry.replace(session);

      void ChargePointModel.findOneAndUpdate(
        { identity },
        { identity, status: "connected", ocppVersion: "1.6", lastSeenAt: new Date() },
        { upsert: true, returnDocument: "after" },
      ).catch((error: unknown) => console.error(error));

      console.log(`[ocpp] ${identity} connected`);

      ws.on("close", () => {
        if (registry.remove(identity, connection)) {
          void ChargePointModel.updateOne({ identity }, { status: "disconnected", lastSeenAt: new Date() });
          console.log(`[ocpp] ${identity} disconnected`);
        }
      });
    });
  });
}
