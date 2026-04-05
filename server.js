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
    },
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname)));

// Store active users
const users = new Map();
const privateRooms = new Map();

// Public chat queues - based on gender (what the user IS)
const femaleQueue = [];  // female users waiting
const maleQueue = [];    // male users waiting

function addToQueue(socketId) {
    const user = users.get(socketId);
    if (!user || user.inQueue || user.partnerId) return;
    
    if (user.gender === 'female') {
        femaleQueue.push(socketId);
        console.log(`[QUEUE] Female ${socketId} added to female queue, size: ${femaleQueue.length}`);
    } else if (user.gender === 'male') {
        maleQueue.push(socketId);
        console.log(`[QUEUE] Male ${socketId} added to male queue, size: ${maleQueue.length}`);
    }
    user.inQueue = true;
}

function removeFromQueue(socketId) {
    const femaleIndex = femaleQueue.indexOf(socketId);
    if (femaleIndex !== -1) {
        femaleQueue.splice(femaleIndex, 1);
        console.log(`[QUEUE] Female ${socketId} removed from queue`);
    }
    
    const maleIndex = maleQueue.indexOf(socketId);
    if (maleIndex !== -1) {
        maleQueue.splice(maleIndex, 1);
        console.log(`[QUEUE] Male ${socketId} removed from queue`);
    }
    
    const user = users.get(socketId);
    if (user) user.inQueue = false;
}

function findMatch(socketId) {
    const user = users.get(socketId);
    if (!user || user.partnerId || user.isInPrivate) return false;
    if (!user.gender || !user.preference) return false;
    
    console.log(`[MATCH] ${socketId} (${user.gender}) wants to chat with ${user.preference}`);
    
    // Determine which queue to look for based on user's PREFERENCE
    let targetQueue;
    if (user.preference === 'female') {
        targetQueue = femaleQueue;
        console.log(`[MATCH] Looking for female users, queue size: ${targetQueue.length}`);
    } else if (user.preference === 'male') {
        targetQueue = maleQueue;
        console.log(`[MATCH] Looking for male users, queue size: ${targetQueue.length}`);
    } else {
        // If preference is 'any', look in both queues
        console.log(`[MATCH] Looking for any gender`);
        // First try female queue
        for (let i = 0; i < femaleQueue.length; i++) {
            const potentialId = femaleQueue[i];
            const potential = users.get(potentialId);
            
            if (!potential || potential.partnerId || potential.isInPrivate || potentialId === socketId) {
                femaleQueue.splice(i, 1);
                i--;
                continue;
            }
            
            // Check if potential user accepts this user's gender
            if (potential.preference === 'any' || potential.preference === user.gender) {
                femaleQueue.splice(i, 1);
                removeFromQueue(socketId);
                
                user.partnerId = potentialId;
                potential.partnerId = socketId;
                user.inQueue = false;
                potential.inQueue = false;
                
                io.to(socketId).emit('connected');
                io.to(potentialId).emit('connected');
                
                console.log(`[MATCH] ✓ SUCCESS: ${socketId} (${user.gender}) <-> ${potentialId} (${potential.gender})`);
                return true;
            }
        }
        
        // Then try male queue
        for (let i = 0; i < maleQueue.length; i++) {
            const potentialId = maleQueue[i];
            const potential = users.get(potentialId);
            
            if (!potential || potential.partnerId || potential.isInPrivate || potentialId === socketId) {
                maleQueue.splice(i, 1);
                i--;
                continue;
            }
            
            if (potential.preference === 'any' || potential.preference === user.gender) {
                maleQueue.splice(i, 1);
                removeFromQueue(socketId);
                
                user.partnerId = potentialId;
                potential.partnerId = socketId;
                user.inQueue = false;
                potential.inQueue = false;
                
                io.to(socketId).emit('connected');
                io.to(potentialId).emit('connected');
                
                console.log(`[MATCH] ✓ SUCCESS: ${socketId} (${user.gender}) <-> ${potentialId} (${potential.gender})`);
                return true;
            }
        }
        
        // No match found
        addToQueue(socketId);
        io.to(socketId).emit('waiting');
        return false;
    }
    
    // Check queue for specific preference
    for (let i = 0; i < targetQueue.length; i++) {
        const potentialId = targetQueue[i];
        const potential = users.get(potentialId);
        
        // Skip if invalid or already matched
        if (!potential || potential.partnerId || potential.isInPrivate || potentialId === socketId) {
            targetQueue.splice(i, 1);
            i--;
            continue;
        }
        
        // Check if potential user accepts this user's gender
        if (potential.preference === 'any' || potential.preference === user.gender) {
            // Remove both from queues
            targetQueue.splice(i, 1);
            removeFromQueue(socketId);
            
            // Match them
            user.partnerId = potentialId;
            potential.partnerId = socketId;
            user.inQueue = false;
            potential.inQueue = false;
            
            // Notify both
            io.to(socketId).emit('connected');
            io.to(potentialId).emit('connected');
            
            console.log(`[MATCH] ✓ SUCCESS: ${socketId} (${user.gender} looking for ${user.preference}) <-> ${potentialId} (${potential.gender} looking for ${potential.preference})`);
            return true;
        }
    }
    
    // No match found, add to queue
    addToQueue(socketId);
    io.to(socketId).emit('waiting');
    console.log(`[MATCH] ${socketId} waiting - no compatible partner found`);
    return false;
}

function removeFromMatch(socketId, notifyPartner = true, reason = 'skipped') {
    const user = users.get(socketId);
    if (!user || !user.partnerId) return false;
    
    const partnerId = user.partnerId;
    const partner = users.get(partnerId);
    
    user.partnerId = null;
    if (partner) {
        partner.partnerId = null;
        if (notifyPartner) {
            const event = reason === 'skipped' ? 'partner skipped' : 
                         (reason === 'ended' ? 'partner ended' : 'partner disconnected');
            io.to(partnerId).emit(event);
            console.log(`[BREAK] Notified ${partnerId}: ${event}`);
        }
        // Re-queue partner if they're not in private
        if (!partner.isInPrivate && partner.gender && partner.preference) {
            findMatch(partnerId);
        }
    }
    
    console.log(`[BREAK] ${socketId} broke with ${partnerId}, reason: ${reason}`);
    return true;
}

// Private room functions
function createPrivateRoom(roomId, creatorId) {
    if (privateRooms.has(roomId)) return false;
    privateRooms.set(roomId, {
        creatorId: creatorId,
        members: new Set([creatorId])
    });
    console.log(`[PRIVATE] Room ${roomId} created by ${creatorId}`);
    return true;
}

function joinPrivateRoom(roomId, joinerId) {
    const room = privateRooms.get(roomId);
    if (!room) return 'not-found';
    if (room.members.size >= 2) return 'full';
    room.members.add(joinerId);
    console.log(`[PRIVATE] ${joinerId} joined room ${roomId}`);
    return 'joined';
}

function leavePrivateRoom(roomId, socketId) {
    const room = privateRooms.get(roomId);
    if (!room) return;
    
    room.members.delete(socketId);
    const otherMember = Array.from(room.members)[0];
    if (otherMember) {
        io.to(otherMember).emit('friend-left');
    }
    
    if (room.members.size === 0) {
        privateRooms.delete(roomId);
        console.log(`[PRIVATE] Room ${roomId} deleted`);
    }
}

// Socket.IO
io.on('connection', (socket) => {
    console.log(`[CONNECT] ${socket.id}`);
    
    // Initialize user
    users.set(socket.id, {
        id: socket.id,
        gender: null,
        preference: null,
        partnerId: null,
        inQueue: false,
        isInPrivate: false,
        roomId: null
    });
    
    io.emit('user-count', users.size);
    
    // Public chat: set user metadata
    socket.on('user-meta', (data) => {
        const user = users.get(socket.id);
        if (user && !user.isInPrivate) {
            user.gender = data.gender;
            user.preference = data.preference;
            console.log(`[META] ${socket.id}: Gender = ${user.gender}, Preference = ${user.preference}`);
            findMatch(socket.id);
        }
    });
    
    // Public chat: send message
    socket.on('message', (msg) => {
        const user = users.get(socket.id);
        if (user && user.partnerId && !user.isInPrivate) {
            io.to(user.partnerId).emit('message', msg);
            console.log(`[MSG] ${socket.id} -> ${user.partnerId}`);
        }
    });
    
    // Public chat: skip
    socket.on('skip-request', () => {
        const user = users.get(socket.id);
        if (user && !user.isInPrivate) {
            console.log(`[SKIP] ${socket.id} requested skip`);
            removeFromMatch(socket.id, true, 'skipped');
            socket.emit('skip-success');
            findMatch(socket.id);
        }
    });
    
    // Public chat: end
    socket.on('end-request', () => {
        const user = users.get(socket.id);
        if (user && !user.isInPrivate) {
            console.log(`[END] ${socket.id} requested end`);
            removeFromMatch(socket.id, true, 'ended');
            socket.emit('end-success');
        }
    });
    
    // Private chat: join room
    socket.on('join-private-room', (data) => {
        const { roomId, isCreator } = data;
        const user = users.get(socket.id);
        if (!user) return;
        
        console.log(`[PRIVATE] ${socket.id} ${isCreator ? 'creating' : 'joining'} room ${roomId}`);
        
        user.isInPrivate = true;
        user.roomId = roomId;
        
        // Leave public chat if in one
        if (user.partnerId) {
            removeFromMatch(socket.id, true, 'disconnected');
        }
        removeFromQueue(socket.id);
        
        if (isCreator) {
            if (createPrivateRoom(roomId, socket.id)) {
                socket.join(roomId);
                socket.emit('room-joined', { roomId, isCreator: true });
            } else {
                socket.emit('room-already-exists', { roomId });
                user.isInPrivate = false;
                user.roomId = null;
            }
        } else {
            const result = joinPrivateRoom(roomId, socket.id);
            if (result === 'joined') {
                socket.join(roomId);
                socket.emit('room-joined', { roomId, isCreator: false });
                const room = privateRooms.get(roomId);
                if (room && room.creatorId) {
                    io.to(room.creatorId).emit('friend-joined');
                }
            } else if (result === 'full') {
                socket.emit('room-joined-full', { roomId });
                user.isInPrivate = false;
                user.roomId = null;
            } else {
                socket.emit('room-not-found', { roomId });
                user.isInPrivate = false;
                user.roomId = null;
            }
        }
    });
    
    // Private chat: send message
    socket.on('private-message', (data) => {
        const { roomId, text } = data;
        const room = privateRooms.get(roomId);
        if (room && room.members.has(socket.id)) {
            for (const memberId of room.members) {
                if (memberId !== socket.id) {
                    io.to(memberId).emit('private-message', { text });
                    console.log(`[PRIVATE-MSG] ${socket.id} -> ${memberId}`);
                }
            }
        }
    });
    
    // Private chat: leave room
    socket.on('leave-private-room', (data) => {
        const { roomId } = data;
        const user = users.get(socket.id);
        if (user) {
            user.isInPrivate = false;
            user.roomId = null;
        }
        leavePrivateRoom(roomId, socket.id);
        socket.leave(roomId);
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] ${socket.id}`);
        
        const user = users.get(socket.id);
        if (user) {
            if (user.roomId) {
                leavePrivateRoom(user.roomId, socket.id);
            }
            if (user.partnerId) {
                removeFromMatch(socket.id, true, 'disconnected');
            }
            removeFromQueue(socket.id);
        }
        
        users.delete(socket.id);
        io.emit('user-count', users.size);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 Socket.IO ready`);
    console.log(`\n📝 Matching Rules:`);
    console.log(`   - User selects preference "Female" → matched with Female user`);
    console.log(`   - User selects preference "Male" → matched with Male user`);
    console.log(`   - User selects preference "Any" → matched with any gender\n`);
});