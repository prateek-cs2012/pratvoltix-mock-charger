export interface OcppTransport {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}

export function transportFromWebSocket(socket: WebSocketLike): OcppTransport {
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onMessage: (listener) => {
      socket.on("message", (data) => listener(String(data)));
    },
    onClose: (listener) => {
      socket.on("close", () => listener());
    },
  };
}

/** In-process duplex used by tests and embedded charge-point simulations. */
export function linkTransports(): { left: OcppTransport; right: OcppTransport } {
  const listeners: Record<"left" | "right", Array<(data: string) => void>> = {
    left: [],
    right: [],
  };
  const closeListeners: Array<() => void> = [];
  let closed = false;

  const notifyClose = () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const listener of closeListeners) {
      listener();
    }
  };

  const make = (side: "left" | "right", peer: "left" | "right"): OcppTransport => ({
    send(data: string) {
      if (closed) {
        return;
      }
      queueMicrotask(() => {
        if (closed) {
          return;
        }
        for (const listener of [...listeners[peer]]) {
          listener(data);
        }
      });
    },
    close: notifyClose,
    onMessage(listener) {
      listeners[side].push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
  });

  return {
    left: make("left", "right"),
    right: make("right", "left"),
  };
}
