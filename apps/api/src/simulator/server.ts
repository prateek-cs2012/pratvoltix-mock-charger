import type { Duplex } from "node:stream";
import type { IncomingMessage, Server } from "node:http";
import { CONTROL_PATH, CONTROL_SUBPROTOCOL, ControlChannel, ControlProtocolError, validateHello } from "@pratvoltix/simulator-control";
import { WebSocketServer } from "ws";
import { SimulatorRegistry } from "./registry.js";

export function attachSimulatorControl(server: Server, registry: SimulatorRegistry): void {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(CONTROL_SUBPROTOCOL) ? CONTROL_SUBPROTOCOL : false),
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== CONTROL_PATH) {
      return;
    }
    const offered = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    if (!offered.includes(CONTROL_SUBPROTOCOL)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      let identity: string | undefined;
      let greeted = false;
      const channel = new ControlChannel((text) => ws.send(text), {
        onProtocolError: (error) => console.error(`[lab-control] ${error.message}`),
        onRequest: (requestMessage) => {
          if (requestMessage.action === "ocpp-frame") {
            if (!greeted || !identity) {
              throw new ControlProtocolError("not-ready", "Simulator control is not ready.");
            }
            registry.ingestOcppFrame(identity, requestMessage.payload);
            return { accepted: true };
          }
          if (requestMessage.action === "ocpp-state") {
            if (!greeted || !identity) {
              throw new ControlProtocolError("not-ready", "Simulator control is not ready.");
            }
            registry.ingestOcppState(identity, requestMessage.payload);
            return { accepted: true };
          }
          if (requestMessage.action !== "hello") {
            throw new ControlProtocolError("not-ready", "Simulator control is not ready.");
          }
          if (greeted) {
            throw new ControlProtocolError("invalid-message", "Simulator already completed hello on this connection.");
          }
          let hello;
          try {
            hello = validateHello(requestMessage.payload);
          } catch (error) {
            if (error instanceof ControlProtocolError && error.code === "unsupported-version") {
              setTimeout(() => ws.close(), 0);
            }
            throw error;
          }
          greeted = true;
          identity = hello.chargePointIdentity;
          registry.accept(hello, channel, () => ws.close());
          console.log(`[lab-control] ${identity} connected`);
          return { accepted: true };
        },
      });

      ws.on("message", (data) => {
        try {
          channel.handleRaw(String(data));
        } catch (error) {
          console.error("[lab-control] message failed", error);
        }
      });
      ws.on("close", () => {
        channel.close();
        if (identity) {
          registry.disconnect(identity, channel);
          console.log(`[lab-control] ${identity} disconnected`);
        }
      });
      ws.on("error", (error) => {
        console.error(`[lab-control] ${error.message}`);
      });
    });
  });
}
