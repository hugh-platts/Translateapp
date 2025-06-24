// server.js
// This server handles signaling for WebRTC and relays translation data.

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new socketIo.Server(server);

// Serve the public directory for the frontend
app.use(express.static('public'));

let roomUsers = {}; // Object to store users in the room

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Event for a user to join the room
    socket.on('join-room', (roomId) => {
        // For simplicity, we'll use a single room 'main-room'
        const room = 'main-room';
        
        // Initialize room if it doesn't exist
        if (!roomUsers[room]) {
            roomUsers[room] = [];
        }
        
        // Assign language based on who joins first
        let userLang = 'en'; // Default to English
        if (roomUsers[room].length === 1) {
            userLang = 'ja'; // Second user is Japanese
        } else if (roomUsers[room].length >= 2) {
            // Room is full
            socket.emit('room-full');
            return;
        }

        socket.join(room);
        roomUsers[room].push({ id: socket.id, lang: userLang });
        socket.data.lang = userLang; // Store lang in socket data
        socket.data.room = room; // Store room in socket data

        console.log(`User ${socket.id} joined room ${room} as ${userLang}`);

        // Send language assignment to the newly joined user
        socket.emit('language-assigned', userLang);

        // Notify other user in the room
        socket.to(room).emit('user-joined', socket.id);
    });

    // Handle WebRTC signaling: offer, answer, ice-candidate
    socket.on('offer', (payload) => {
        io.to(payload.target).emit('offer', payload);
    });

    socket.on('answer', (payload) => {
        io.to(payload.target).emit('answer', payload);
    });

    socket.on('ice-candidate', (payload) => {
        io.to(payload.target).emit('ice-candidate', payload);
    });

    // Relay caption data to the other user in the room
    socket.on('send-caption', (captionData) => {
        socket.to(socket.data.room).emit('new-caption', captionData);
    });

    // Handle user disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const room = socket.data.room;
        if (room && roomUsers[room]) {
            // Remove user from the room
            roomUsers[room] = roomUsers[room].filter(user => user.id !== socket.id);
            // If room is empty, clear it
            if (roomUsers[room].length === 0) {
                delete roomUsers[room];
            }
        }
        socket.to(room).emit('user-left', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in two browser tabs to start a call.`);
});
