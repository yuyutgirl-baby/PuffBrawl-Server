
import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("PuffBrawl Online Server is running.");
    }

    if (url.pathname !== "/ws") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }

    const id = env.ROOMS.idFromName("puffbrawl-main");
    return env.ROOMS.get(id).fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
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
        status: "waiting",
        queue: false
      });

      server.send(JSON.stringify({
        type: "room-created",
        code
      }));

    } else if (mode === "join") {
      const code = (url.searchParams.get("code") || "")
        .trim()
        .toUpperCase();

      if (!/^[A-Z0-9]{6}$/.test(code)) {
        this.sendError(server, "Código de sala inválido.");
      } else {
        const host = this.ctx.getWebSockets().find(ws => {
          if (ws === server) return false;

          const data = ws.deserializeAttachment();

          return data?.code === code &&
            data?.player === 1 &&
            data?.status === "waiting" &&
            data?.queue === false;
        });

        if (!host) {
          this.sendError(server, "Sala não encontrada ou já está cheia.");
        } else {
          host.serializeAttachment({
            ...host.deserializeAttachment(),
            status: "playing"
          });

          server.serializeAttachment({
            code,
            player: 2,
            status: "playing",
            queue: false
          });

          host.send(JSON.stringify({
            type: "opponent-joined",
            player: 2
          }));

          server.send(JSON.stringify({
            type: "room-joined",
            code,
            player: 2
          }));
        }
      }

    } else if (mode === "match") {
      const waiting = this.ctx.getWebSockets().find(ws => {
        if (ws === server) return false;

        const data = ws.deserializeAttachment();

        return data?.status === "waiting" &&
          data?.queue === true;
      });

      if (waiting) {
        const code = this.makeCode();

        waiting.serializeAttachment({
          code,
          player: 1,
          status: "playing",
          queue: false
        });

        server.serializeAttachment({
          code,
          player: 2,
          status: "playing",
          queue: false
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
          player: 0,
          status: "waiting",
          queue: true
        });

        server.send(JSON.stringify({
          type: "searching"
        }));
      }

    } else {
      this.sendError(server, "Modo inválido.");
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(ws, message) {
    const data = ws.deserializeAttachment();

    if (!data?.code || data.status !== "playing") return;

    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;

      const peerData = peer.deserializeAttachment();

      if (
        peerData?.code === data.code &&
        peerData?.status === "playing"
      ) {
        try {
          peer.send(message);
        } catch {
          try {
            peer.close(1011, "Falha ao encaminhar mensagem");
          } catch {}
        }
      }
    }
  }

  webSocketClose(ws) {
    const data = ws.deserializeAttachment();

    if (!data?.code) return;

    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;

      const peerData = peer.deserializeAttachment();

      if (peerData?.code === data.code) {
        peer.serializeAttachment({
          ...peerData,
          status: "disconnected"
        });

        try {
          peer.send(JSON.stringify({
            type: "opponent-left"
          }));
        } catch {}
      }
    }
  }

  webSocketError(ws) {
    try {
      ws.close(1011, "Erro de WebSocket");
    } catch {}
  }

  sendError(ws, message) {
    try {
      ws.send(JSON.stringify({
        type: "error",
        message
      }));

      ws.close(1008, message);
    } catch {}
  }

  makeCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;

    do {
      code = "";

      for (let i = 0; i < 6; i++) {
        code += chars[
          Math.floor(Math.random() * chars.length)
        ];
      }

    } while (this.ctx.getWebSockets().some(ws => {
      const data = ws.deserializeAttachment();

      return data?.code === code &&
        (
          data.status === "waiting" ||
          data.status === "playing"
        );
    }));

    return code;
  }
}
