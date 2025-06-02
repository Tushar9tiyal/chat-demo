const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Store rooms and their users
const rooms = new Map(); // roomId -> { users: Map(username -> socketId), createdAt: Date }
const userSockets = new Map(); // socketId -> { username, roomId }

// Clean up empty rooms periodically
setInterval(() => {
    const now = Date.now();
    const ROOM_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const [roomId, room] of rooms) {
        if (room.users.size === 0 && (now - room.createdAt.getTime()) > ROOM_TIMEOUT) {
            rooms.delete(roomId);
            console.log(`🗑️  Cleaned up empty room: ${roomId}`);
        }
    }
}, 60 * 60 * 1000); // Check every hour

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    // Handle user joining a room
    socket.on('join-room', (data) => {
        const { username, roomId } = data;
        console.log("User joined: ", username, roomId);
        // Validate input
        if (!username || !roomId) {
            socket.emit('error', { message: 'Username and room ID are required' });
            return;
        }
        
        if (username.length > 20 || roomId.length > 50) {
            socket.emit('error', { message: 'Username or room ID too long' });
            return;
        }

        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                users: new Map(),
                createdAt: new Date()
            });
            console.log(`🏠 Created new room: ${roomId}`);
        }

        const room = rooms.get(roomId);
        
        // Check if username is already taken in this room
        if (room.users.has(username)) {
            socket.emit('username-taken', { message: 'Username already taken in this room' });
            return;
        }

        // Join the socket.io room
        socket.join(roomId);
        
        // Store user info
        room.users.set(username, socket.id);
        userSockets.set(socket.id, { username, roomId });
        socket.username = username;
        socket.roomId = roomId;

        console.log(`👤 User ${username} joined room ${roomId}`);

        // Send updated users list to all clients in the room
        const usersList = Array.from(room.users.keys());
        io.to(roomId).emit('users-list', usersList);

        // Notify other users in the room
        socket.to(roomId).emit('user-joined', {
            username: username,
            users: usersList
        });

        // Send welcome message to the new user
        socket.emit('room-joined', {
            roomId: roomId,
            users: usersList
        });
    });

    // Handle encrypted message
    socket.on('send-message', (data) => {
        const { username, encrypted, timestamp, secret } = data;
        console.log(data)
        // Validate user and room
        if (!socket.username || !socket.roomId || socket.username !== username) {
            console.log('❌ Invalid user trying to send message');
            return;
        }

        // Broadcast encrypted message to all other users in the room
        socket.to(socket.roomId).emit('encrypted-message', {
            username,
            encrypted,
            secret,
            timestamp
        });

        console.log(`💬 Message from ${username} in room ${socket.roomId} (encrypted)`);
    });

    // Handle typing indicator
    socket.on('typing', (data) => {
        console.log("typing: ", socket)
        if (!socket.roomId) return;
        
        socket.to(socket.roomId).emit('user-typing', {
            username: data.username,
            isTyping: data.isTyping
        });
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        const userInfo = userSockets.get(socket.id);
        
        if (userInfo) {
            const { username, roomId } = userInfo;
            const room = rooms.get(roomId);
            
            if (room) {
                // Remove user from room
                room.users.delete(username);
                
                console.log(`👋 User ${username} left room ${roomId}`);
                
                // Send updated users list to remaining clients in the room
                const usersList = Array.from(room.users.keys());
                io.to(roomId).emit('users-list', usersList);
                
                // Notify other users in the room
                socket.to(roomId).emit('user-left', {
                    username: username,
                    users: usersList
                });
                
                // Clean up empty room (keep for a while in case user reconnects)
                if (room.users.size === 0) {
                    console.log(`🏠 Room ${roomId} is now empty`);
                }
            }
            
            userSockets.delete(socket.id);
        } else {
            console.log(`🔌 Unknown client disconnected: ${socket.id}`);
        }
    });

    // Handle room info request
    socket.on('get-room-info', (data) => {
        const { roomId } = data;
        const room = rooms.get(roomId);
        
        if (room) {
            socket.emit('room-info', {
                roomId: roomId,
                userCount: room.users.size,
                users: Array.from(room.users.keys()),
                exists: true
            });
        } else {
            socket.emit('room-info', {
                roomId: roomId,
                exists: false
            });
        }
    });

    // Handle errors
    socket.on('error', (error) => {
        console.error('❌ Socket error:', error);
    });
});

// API endpoint to check room status
app.get('/api/room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms.get(roomId);
    
    if (room) {
        res.json({
            exists: true,
            userCount: room.users.size,
            createdAt: room.createdAt
        });
    } else {
        res.json({
            exists: false
        });
    }
});

// API endpoint to get server stats
app.get('/api/stats', (req, res) => {
    const totalUsers = Array.from(rooms.values()).reduce((sum, room) => sum + room.users.size, 0);
    
    res.json({
        totalRooms: rooms.size,
        totalUsers: totalUsers,
        uptime: process.uptime()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Handle 404
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// Handle server shutdown gracefully
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down server gracefully...');
    
    // Notify all connected users
    io.emit('server-shutdown', { message: 'Server is shutting down' });
    
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('🔄 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 SecureChat server running on port ${PORT}`);
    console.log(`📱 Open http://localhost:${PORT} in your browser`);
    console.log(`🔐 End-to-end encryption enabled`);
    console.log(`🏠 Private rooms supported`);
});

// Log server statistics periodically
setInterval(() => {
    const totalUsers = Array.from(rooms.values()).reduce((sum, room) => sum + room.users.size, 0);
    console.log(`📊 Server stats: ${rooms.size} rooms, ${totalUsers} users connected`);
}, 60000); // Log every minute