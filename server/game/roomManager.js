const { Room } = require('./room');

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
  }

  createRoom(hostSocketId, options) {
    let room = new Room(hostSocketId, options);
    // Evitar colisiones de código (muy improbable, pero por si acaso)
    while (this.rooms.has(room.code)) {
      room = new Room(hostSocketId, options);
    }
    this.rooms.set(room.code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  deleteRoom(code) {
    this.rooms.delete(code);
  }

  // Limpia salas vacías/abandonadas periódicamente.
  cleanup(maxAgeMs = 1000 * 60 * 60 * 6) {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      const noPlayers = room.players.size === 0;
      const stale = now - room.createdAt > maxAgeMs;
      if (noPlayers || stale) this.rooms.delete(code);
    }
  }
}

module.exports = { RoomManager };
