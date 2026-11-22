
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("PuffBrawl Online Server is running.");
    }

    if (url.pathname !== "/ws") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }

    const id = env.ROOMS.idFromName("puffbrawl-main");
    const room = env.ROOMS.get(id);

    return room.fetch(request);
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    if (mode === "create") {
      const code = this.makeCode();

      server.serializeAttachment({
        code,
        player: 1,
        status: "playing"
      });

      server.send(JSON.stringify({
        type: "room-created",
        code
      }));
    }

    else if (mode === "join") {
      const code = (url.searchParams.get("code") || "").toUpperCase();

      const existing = this.ctx.getWebSockets()
        .find(ws => {
          const data = ws.deserializeAttachment();
          return data?.code === code && data?.status === "playing";
        });

      if (!existing) {
        server.send(JSON.stringify({
          type: "error",
          message: "Sala não encontrada."
        }));
        server.close();
      } else {
        server.serializeAttachment({
          code,
          player: 2,
          status: "playing"
        });

        existing.send(JSON.stringify({
          type: "opponent-joined"
        }));

        server.send(JSON.stringify({
          type: "room-joined",
          code
        }));
      }
    }

    else if (mode === "match") {
      const waiting = this.ctx.getWebSockets()
        .find(ws => {
          const data = ws.deserializeAttachment();
          return data?.status === "waiting";
        });

      if (waiting) {
        const code = this.makeCode();

        waiting.serializeAttachment({
          code,
          player: 1,
          status: "playing"
        });

        server.serializeAttachment({
          code,
          player: 2,
          status: "playing"
        });

        waiting.send(JSON.stringify({
          type: "match-found",
          player: 1
        }));

        server.send(JSON.stringify({
          type: "match-found",
          player: 2
        }));
      } else {
        server.serializeAttachment({
          status: "waiting"
        });

        server.send(JSON.stringify({
          type: "searching"
        }));
      }
    }

    else {
      server.send(JSON.stringify({
        type: "error",
        message: "Modo inválido."
      }));
      server.close();
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(ws, message) {
    const data = ws.deserializeAttachment();

    if (!data?.code) return;

    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;

      const peerData = peer.deserializeAttachment();

      if (peerData?.code === data.code) {
        peer.send(message);
      }
    }
  }

  webSocketClose(ws) {
    const data = ws.deserializeAttachment();

    if (!data?.code) return;

    for (const peer of this.ctx.getWebSockets()) {
      const peerData = peer.deserializeAttachment();

      if (peerData?.code === data.code) {
        peer.send(JSON.stringify({
          type: "opponent-left"
        }));
      }
    }
  }

  webSocketError(ws) {
    ws.close();
  }

  makeCode() {
    return Math.random().toString(36)
      .substring(2, 8).toUpperCase();
  }
}
