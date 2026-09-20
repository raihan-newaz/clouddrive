class EventBroadcaster {
  constructor() {
    this.clients = new Set();
  }

  addClient(res, userId = null) {
    const client = { res, userId, id: Date.now() + Math.random() };
    this.clients.add(client);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('data: {"type":"connected"}\n\n');

    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch (e) {
        clearInterval(keepAlive);
      }
    }, 20000);

    res.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(client);
    });
  }

  broadcast(eventType, payload, targetUserId = null) {
    const data = JSON.stringify(payload || {});
    for (const client of this.clients) {
      if (!targetUserId || client.userId === targetUserId || !client.userId) {
        try {
          client.res.write(`event: ${eventType}\ndata: ${data}\n\n`);
        } catch (e) {
          this.clients.delete(client);
        }
      }
    }
  }
}

const eventBroadcaster = new EventBroadcaster();
module.exports = eventBroadcaster;
