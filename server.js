const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["https://poker-scrum-free.netlify.app"],
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true
});

app.use(cors({
  origin: ["https://poker-scrum-free.netlify.app"],
  credentials: true
}));
app.use(express.json());

// In-memory storage for rooms and users
const rooms = new Map();
const userSockets = new Map(); // Maps socket.id to user data

// Fibonacci sequence for SCRUM poker
const FIBONACCI_CARDS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 'infinity', '?', 'coffee'];

class Room {
  constructor(code, createdBy) {
    this.code = code;
    this.createdBy = createdBy;
    this.hostId = createdBy;
    this.users = new Map();
    this.gameState = {
      phase: 'voting', // 'voting' or 'revealed'
      selections: new Map(),
      revealedAt: null
    };
    this.settings = {
      onlyHostCanReveal: true,
      allowRevealWithMissingVotes: false
    };
    this.createdAt = new Date();
  }

  addUser(user) {
    this.users.set(user.id, user);
  }

  removeUser(userId) {
    this.users.delete(userId);
    this.gameState.selections.delete(userId);
  }
  selectCard(userId, card) {
    if (this.gameState.phase === 'voting') {
      // Validate card value including new special cards
      const validCards = [0, 1, 2, 3, 5, 8, 13, 21, 34, 'infinity', '?', 'coffee'];
      if (validCards.includes(card)) {
        this.gameState.selections.set(userId, card);
      }
    }
  }

  canRevealCards(userId) {
    if (this.settings.onlyHostCanReveal && userId !== this.hostId) {
      return false;
    }
    
    if (!this.settings.allowRevealWithMissingVotes) {
      // Check if all users have selected a card
      const totalUsers = this.users.size;
      const totalSelections = this.gameState.selections.size;
      return totalUsers === totalSelections;
    }
    
    return true;
  }

  transferHost(newHostId) {
    if (this.users.has(newHostId)) {
      this.hostId = newHostId;
      return true;
    }
    return false;
  }

  updateSettings(settings) {
    this.settings = { ...this.settings, ...settings };
  }

  revealCards() {
    this.gameState.phase = 'revealed';
    this.gameState.revealedAt = new Date();
  }
  resetGame() {
    this.gameState.phase = 'voting';
    this.gameState.selections.clear();
    this.gameState.revealedAt = null;
    
    // Clear user selections
    this.users.forEach(user => {
      user.selectedCard = null;
      user.hasSelected = false;
    });
  }
  getGameState() {
    const users = Array.from(this.users.values()).map(user => ({
      ...user,
      selectedCard: user.selectedCard ?? null,
      isHost: user.id === this.hostId
    }));
    const selections = this.gameState.phase === 'revealed' 
      ? Object.fromEntries(this.gameState.selections)
      : Object.fromEntries(
          Array.from(this.gameState.selections.entries()).map(([userId, _]) => [userId, 'selected'])
        );

    return {
      code: this.code,
      users,
      phase: this.gameState.phase,
      selections,
      revealedAt: this.gameState.revealedAt,
      hostId: this.hostId,
      settings: this.settings
    };
  }
  getResults() {
    if (this.gameState.phase !== 'revealed') return null;

    const cardCounts = new Map();
    const userSelections = [];
    const numericValues = [];

    for (const [userId, card] of this.gameState.selections) {
      const user = this.users.get(userId);
      if (user) {
        userSelections.push({ user: user.name, card });
        cardCounts.set(card, (cardCounts.get(card) || 0) + 1);
        
        // Only include numeric values for average calculation
        if (typeof card === 'number' && card !== 0) {
          numericValues.push(card);
        }
      }
    }

    // Find most selected card
    let mostSelected = null;
    let maxCount = 0;
    for (const [card, count] of cardCounts) {
      if (count > maxCount) {
        maxCount = count;
        mostSelected = card;
      }
    }

    // Calculate average of numeric values only
    const average = numericValues.length > 0 
      ? numericValues.reduce((sum, val) => sum + val, 0) / numericValues.length 
      : 0;

    return {
      userSelections: userSelections.sort((a, b) => a.user.localeCompare(b.user)),
      mostSelected,
      totalVotes: userSelections.length,
      average: Math.round(average * 100) / 100 // Round to 2 decimal places
    };
  }
}

// Generate a unique 5-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle user joining with username
  socket.on('join', (data) => {
    const { username } = data;
    const user = {
      id: socket.id,
      name: username,
      socketId: socket.id
    };
    
    userSockets.set(socket.id, user);
    socket.emit('joined', { user });
    console.log(`User ${username} joined with socket ${socket.id}`);
  });

  // Handle creating a new room
  socket.on('createRoom', (data) => {
    const user = userSockets.get(socket.id);
    if (!user) {
      socket.emit('error', { message: 'User not found. Please refresh and try again.' });
      return;
    }

    const roomCode = generateRoomCode();
    const room = new Room(roomCode, user.id);
    room.addUser(user);
    rooms.set(roomCode, room);

    socket.join(roomCode);
    socket.emit('roomCreated', { 
      room: room.getGameState(),
      user
    });

    console.log(`User ${user.name} created room ${roomCode}`);
  });

  // Handle joining an existing room
  socket.on('joinRoom', (data) => {
    const { roomCode } = data;
    const user = userSockets.get(socket.id);
    
    if (!user) {
      socket.emit('error', { message: 'User not found. Please refresh and try again.' });
      return;
    }

    const room = rooms.get(roomCode.toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found. Please check the room code.' });
      return;
    }

    // Check if user is already in the room (reconnection)
    const existingUser = Array.from(room.users.values()).find(u => u.name === user.name);
    if (existingUser) {
      // Update the socket ID for reconnection
      existingUser.socketId = socket.id;
      room.users.set(existingUser.id, existingUser);
      userSockets.set(socket.id, existingUser);
    } else {
      room.addUser(user);
    }

    socket.join(roomCode);
    socket.emit('roomJoined', { 
      room: room.getGameState(),
      user: existingUser || user
    });

    // Notify other users in the room
    socket.to(roomCode).emit('userJoined', { 
      user: existingUser || user,
      room: room.getGameState()
    });

    console.log(`User ${user.name} joined room ${roomCode}`);
  });
  // Handle card selection
  socket.on('selectCard', (data) => {
    const { roomCode, card } = data;
    const user = userSockets.get(socket.id);
    
    if (!user) {
      socket.emit('error', { message: 'User not found. Please refresh and try again.' });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    const validCards = [0, 1, 2, 3, 5, 8, 13, 21, 34, 'infinity', '?', 'coffee'];
    if (!validCards.includes(card)) {
      socket.emit('error', { message: 'Invalid card selected.' });
      return;
    }

    room.selectCard(user.id, card);
    
    // Emit to all users in the room
    io.to(roomCode).emit('cardSelected', {
      userId: user.id,
      room: room.getGameState()
    });

    console.log(`User ${user.name} selected card ${card} in room ${roomCode}`);
  });
  // Handle revealing cards
  socket.on('revealCards', (data) => {
    const { roomCode } = data;
    const user = userSockets.get(socket.id);
    
    if (!user) {
      socket.emit('error', { message: 'User not found. Please refresh and try again.' });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    // Check if user can reveal cards
    if (!room.canRevealCards(user.id)) {
      socket.emit('error', { message: 'You do not have permission to reveal cards or not all users have voted.' });
      return;
    }

    room.revealCards();
    const results = room.getResults();
    
    // Emit to all users in the room
    io.to(roomCode).emit('cardsRevealed', {
      room: room.getGameState(),
      results
    });

    console.log(`Cards revealed in room ${roomCode}`);
  });

  // Handle resetting the game
  socket.on('resetGame', (data) => {
    const { roomCode } = data;
    const user = userSockets.get(socket.id);
    
    if (!user) {
      socket.emit('error', { message: 'User not found. Please refresh and try again.' });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    room.resetGame();
    
    // Emit to all users in the room
    io.to(roomCode).emit('gameReset', {
      room: room.getGameState()
    });

    console.log(`Game reset in room ${roomCode}`);
  });

  // Handle leaving a room
  socket.on('leaveRoom', (data) => {
    const { roomCode } = data;
    const user = userSockets.get(socket.id);
    
    if (!user) {
      socket.emit('error', { message: 'User not found. Please refresh and try again.' });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    // Remove user from room
    room.removeUser(user.id);
    socket.leave(roomCode);

    // Notify other users in the room
    socket.to(roomCode).emit('userLeft', {
      userId: user.id,
      room: room.getGameState()
    });

    // Confirm to the leaving user
    socket.emit('leftRoom', { success: true });

    // If room is empty, it will be cleaned up by the periodic cleanup    console.log(`User ${user.name} left room ${roomCode}`);
  });

  // Handle transferring host
  socket.on('transferHost', (data) => {
    const { roomCode, newHostId } = data;
    const user = userSockets.get(socket.id);
    
    if (!user) {
      socket.emit('error', { message: 'User not found. Please refresh and try again.' });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    // Only current host can transfer ownership
    if (room.hostId !== user.id) {
      socket.emit('error', { message: 'Only the host can transfer ownership.' });
      return;
    }

    if (room.transferHost(newHostId)) {
      // Notify all users about the host change
      io.to(roomCode).emit('hostTransferred', {
        newHostId,
        room: room.getGameState()
      });
      console.log(`Host transferred to user ${newHostId} in room ${roomCode}`);
    } else {
      socket.emit('error', { message: 'Failed to transfer host. User not found.' });
    }
  });

  // Handle kicking a user
  socket.on('kickUser', (data) => {
    const { roomCode, userId } = data;
    const user = userSockets.get(socket.id);
    
    if (!user) {
      socket.emit('error', { message: 'User not found. Please refresh and try again.' });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    // Only host can kick users
    if (room.hostId !== user.id) {
      socket.emit('error', { message: 'Only the host can kick users.' });
      return;
    }

    // Can't kick yourself
    if (userId === user.id) {
      socket.emit('error', { message: 'You cannot kick yourself.' });
      return;
    }

    // Find the user's socket and kick them
    const userToKick = Array.from(userSockets.entries()).find(([socketId, userData]) => userData.id === userId);
    if (userToKick) {
      const [kickedSocketId] = userToKick;
      const kickedSocket = io.sockets.sockets.get(kickedSocketId);
      
      if (kickedSocket) {
        // Remove user from room
        room.removeUser(userId);
        kickedSocket.leave(roomCode);
        
        // Notify the kicked user
        kickedSocket.emit('kicked', { roomCode });
        
        // Notify other users
        socket.to(roomCode).emit('userKicked', {
          userId,
          room: room.getGameState()
        });
        
        console.log(`User ${userId} was kicked from room ${roomCode}`);
      }
    }
  });

  // Handle room settings update
  socket.on('updateRoomSettings', (data) => {
    const { roomCode, settings } = data;
    const user = userSockets.get(socket.id);
    
    if (!user) {
      socket.emit('error', { message: 'User not found. Please refresh and try again.' });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }

    // Only host can update settings
    if (room.hostId !== user.id) {
      socket.emit('error', { message: 'Only the host can update room settings.' });
      return;
    }

    room.updateSettings(settings);
    
    // Notify all users about settings change
    io.to(roomCode).emit('roomSettingsUpdated', {
      settings: room.settings,
      room: room.getGameState()
    });

    console.log(`Room settings updated in ${roomCode}:`, settings);
  });// Handle disconnection
  socket.on('disconnect', () => {
    const user = userSockets.get(socket.id);
    if (user) {
      console.log(`User ${user.name} disconnected`);
      
      // Find and handle user in any rooms they were in
      for (const [roomCode, room] of rooms) {
        if (room.users.has(user.id)) {
          // Remove user immediately on disconnect (no waiting for reconnection)
          room.removeUser(user.id);
          
          // Notify other users that this user left
          // Use io.to() instead of socket.to() since this socket is disconnecting
          io.to(roomCode).emit('userLeft', { 
            userId: user.id,
            room: room.getGameState()
          });
          
          console.log(`User ${user.name} removed from room ${roomCode} due to disconnect`);
          
          // If room becomes empty, optionally clean it up immediately
          if (room.users.size === 0) {
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} deleted - no users remaining`);
          }
        }
      }
      
      userSockets.delete(socket.id);
    }
  });
});

// Clean up empty rooms periodically
setInterval(() => {
  const now = new Date();
  for (const [roomCode, room] of rooms) {
    // Remove rooms that are older than 24 hours and have no users
    const roomAge = now - room.createdAt;
    const hasActiveUsers = Array.from(room.users.values()).some(user => 
      Array.from(userSockets.values()).some(socketUser => socketUser.id === user.id)
    );
    
    if (roomAge > 24 * 60 * 60 * 1000 && !hasActiveUsers) {
      rooms.delete(roomCode);
      console.log(`Cleaned up inactive room: ${roomCode}`);
    }
  }
}, 60 * 60 * 1000); // Run every hour

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    users: userSockets.size,
    timestamp: new Date().toISOString()
  });
});

// Get room info endpoint
app.get('/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({
    code: room.code,
    userCount: room.users.size,
    phase: room.gameState.phase,
    createdAt: room.createdAt
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Pocket SCRUM Server running on port ${PORT}`);
  console.log(`📱 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
