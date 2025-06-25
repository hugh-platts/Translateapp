// server.js
// This server handles signaling for WebRTC and relays translation data.

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new socketIo.Server(server, {
    cors: {
        origin: "*", // Allow all origins for simplicity, restrict in production
    }
});

// Serve the public directory for the frontend
app.use(express.static('public'));

let rooms = {}; // Object to store room information

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join-room', (roomId) => {
        // Initialize room if it doesn't exist
        if (!rooms[roomId]) {
            rooms[roomId] = [];
        }
        
        // Prevent more than two users from joining
        if (rooms[roomId].length >= 2) {
            socket.emit('room-full');
            return;
        }

        // Assign language based on who joins first
        const userLang = rooms[roomId].length === 0 ? 'en' : 'ja';

        socket.join(roomId);
        rooms[roomId].push(socket.id);
        socket.data.roomId = roomId;
        socket.data.lang = userLang;

        console.log(`User ${socket.id} joined room ${roomId} as ${userLang}`);

        // Send language assignment to the newly joined user
        socket.emit('language-assigned', userLang);

        // If another user is already in the room, notify them
        const otherUser = rooms[roomId].find(id => id !== socket.id);
        if (otherUser) {
            socket.to(otherUser).emit('user-joined', { peerId: socket.id });
        }
    });

    // Handle WebRTC signaling: offer, answer, ice-candidate
    socket.on('offer', (payload) => {
        io.to(payload.target).emit('offer', { sdp: payload.sdp, caller: socket.id });
    });

    socket.on('answer', (payload) => {
        io.to(payload.target).emit('answer', { sdp: payload.sdp });
    });

    socket.on('ice-candidate', (payload) => {
        io.to(payload.target).emit('ice-candidate', { candidate: payload.candidate });
    });

    // Relay caption data to the other user in the room
    socket.on('send-caption', (captionData) => {
        const roomId = socket.data.roomId;
        const otherUser = rooms[roomId]?.find(id => id !== socket.id);
        if (otherUser) {
            socket.to(otherUser).emit('new-caption', captionData);
        }
    });
    
    // Handle call ending
    socket.on('end-call', () => {
        handleDisconnect(socket);
    });

    // Handle user disconnection
    socket.on('disconnect', () => {
        handleDisconnect(socket);
    });
});

function handleDisconnect(socket) {
    console.log('User disconnected:', socket.id);
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
        // Notify the other user
        const otherUser = rooms[roomId].find(id => id !== socket.id);
        if (otherUser) {
            io.to(otherUser).emit('user-left');
        }
        // Remove user from the room
        rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
        if (rooms[roomId].length === 0) {
            delete rooms[roomId];
        }
    }
}


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in two browser tabs to start a call.`);
});
