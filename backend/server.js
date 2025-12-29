// backend/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const cors = require('cors');
const { connectDB, Order } = require('./config/db');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const redis = new Redis({ host: 'localhost', port: 6379 });
const PORT = 4000;

connectDB();

const WAREHOUSES = [
    { id: 1, name: "Hyde Park Depot", lat: 51.508, lng: -0.165 },
    { id: 2, name: "Canary Wharf Hub", lat: 51.503, lng: -0.019 },
    { id: 3, name: "Camden Town Storage", lat: 51.539, lng: -0.142 }
];

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.get('/api/warehouses', (req, res) => res.json(WAREHOUSES));

// --- 1. HEARTBEAT: Update Location & Status ---
app.post('/api/driver-locations', async (req, res) => {
    const { drivers } = req.body;
    if (!drivers || !drivers.length) return res.sendStatus(200);

    // LOG ONCE: Show us that the simulator is connected
    // We store a simple flag so we don't spam the console
    if (!global.hasReceivedHeartbeat) {
        console.log(`💓 Heartbeat received from ${drivers.length} drivers.`);
        global.hasReceivedHeartbeat = true;
    }
    
    const pipeline = redis.pipeline();
    drivers.forEach(d => {
        pipeline.geoadd('drivers', d.lng, d.lat, d.id);
        // FORCE UPDATE status
        pipeline.hset('driver_statuses', d.id, d.status); 
    });
    await pipeline.exec();
    
    io.emit('drivers_update', drivers);
    res.send({ status: 'OK' });
});

// --- 2. CREATE ORDER ---
app.post('/api/orders', async (req, res) => {
    const { customer_name, item, lat, lng } = req.body;
    console.log(`📥 Processing order for ${customer_name}...`);

    try {
        let nearestWarehouse = WAREHOUSES[0];
        let minDist = Infinity;
        WAREHOUSES.forEach(w => {
            const dist = getDistance(lat, lng, w.lat, w.lng);
            if (dist < minDist) { minDist = dist; nearestWarehouse = w; }
        });

        // Get Candidates
        const candidates = await redis.georadius('drivers', nearestWarehouse.lng, nearestWarehouse.lat, 50, 'km', 'ASC', 'COUNT', 10);
        
        let assignedDriverId = null;

        // DEBUG: Print candidates
        console.log(`🔍 Found ${candidates.length} candidates nearby.`);

        for (const driverId of candidates) {
            let status = await redis.hget('driver_statuses', driverId);
            
            // FIX: If status is NULL (Simulator hasn't reported yet), treat as IDLE
            if (!status) status = 'IDLE';

            // DEBUG LOG: See exactly what the server sees
            // console.log(`   > Checking ${driverId}: Status is [${status}]`);

            if (status === 'IDLE') {
                assignedDriverId = driverId;
                // Lock them immediately
                await redis.hset('driver_statuses', driverId, 'ASSIGNED');
                break;
            }
        }

        if (!assignedDriverId) {
            console.log("⚠️ All nearby drivers are busy (Status != IDLE)");
            return res.status(404).json({ message: "Drivers are busy. Please try again." });
        }

        // Create Order
        const newOrder = await Order.create({
            customer_name, item, driver_id: assignedDriverId,
            delivery_lat: lat, delivery_lng: lng, status: 'ASSIGNED'
        });

        const missionData = {
            orderId: newOrder.id,
            driverId: assignedDriverId,
            warehouse: nearestWarehouse,
            customer: { lat, lng }
        };

        await redis.set(`mission:${assignedDriverId}`, JSON.stringify(missionData));
        
        io.emit('order_created', { 
            id: newOrder.id, lat, lng, driverId: assignedDriverId, status: 'ASSIGNED' 
        });

        console.log(`✅ Assigned ${assignedDriverId} to Order #${newOrder.id}`);
        res.json({ success: true, order: newOrder });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server Error" });
    }
});

app.post('/api/orders/finish', async (req, res) => {
    const { orderId, driverId } = req.body;
    try {
        await Order.update({ status: 'DELIVERED' }, { where: { id: orderId } });
        console.log(`🏁 Order ${orderId} Complete.`);
        io.emit('order_finished', { orderId });
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).send("Error"); }
});

server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));