// frontend/src/components/Map.jsx
import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import io from 'socket.io-client';

// --- ICONS ---
const createIcon = (color) => new L.Icon({
    iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
});

const icons = {
    blue: createIcon('blue'),
    green: createIcon('green'),
    red: createIcon('red'),
    gold: createIcon('gold')
};

const socket = io('http://localhost:4000');

function LocationMarker({ setModalOpen, setTempCoords }) {
    useMapEvents({
        click(e) {
            setTempCoords(e.latlng);
            setModalOpen(true);
        },
    });
    return null;
}

const Map = () => {
    const [drivers, setDrivers] = useState([]);
    const [warehouses, setWarehouses] = useState([]);
    const [activeOrders, setActiveOrders] = useState([]); 
    
    const [modalOpen, setModalOpen] = useState(false);
    const [tempCoords, setTempCoords] = useState(null); 
    const [formData, setFormData] = useState({ name: '', item: '' });

    // New: We need to map active orders to drivers to draw lines
    // We'll store missions in a simple object: { driverId: { target: [lat, lng], type: 'pickup'|'delivery' } }
    const [lines, setLines] = useState([]);

    useEffect(() => {
        fetch('http://localhost:4000/api/warehouses')
            .then(res => res.json())
            .then(data => setWarehouses(data));

        socket.on('order_created', (newOrder) => {
            setActiveOrders(prev => [...prev, newOrder]);
        });

        socket.on('order_finished', ({ orderId }) => {
            setActiveOrders(prev => prev.filter(o => o.id !== orderId));
        });

        return () => {
            socket.off('order_created');
            socket.off('order_finished');
        };
    }, []);

    // Separate effect to handle driver updates and calculate lines
    useEffect(() => {
        socket.on('drivers_update', (updatedDrivers) => {
            setDrivers(updatedDrivers);
            
            // Calculate Lines for Visualization
            const newLines = [];
            updatedDrivers.forEach(d => {
                if (d.status === 'TO_WAREHOUSE' || d.status === 'TO_CUSTOMER') {
                    // We need to find WHERE they are going. 
                    // In a real app, the driver object would have the target coords.
                    // For this demo, we'll cheat slightly and find the order linked to this driver.
                    
                    // Note: This is a visualization-only heuristic
                    // Ideally, pass 'target' in the driver update from backend
                }
            });
            // (Simpler approach for Phase 6: Just draw lines for Active Orders if we know the driver position)
        });

        return () => socket.off('drivers_update');
    }, [activeOrders]);

    const handleOrder = async (e) => {
        e.preventDefault();
        try {
            const response = await fetch('http://localhost:4000/api/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customer_name: formData.name,
                    item: formData.item,
                    lat: tempCoords.lat,
                    lng: tempCoords.lng
                })
            });
            const data = await response.json();
            if (data.success) {
                setModalOpen(false);
                setFormData({ name: '', item: '' });
            }
        } catch (error) { console.error(error); }
    };

    // Helper to find driver position for a specific order
    const getDriverPos = (driverId) => {
        const d = drivers.find(d => d.id === driverId);
        return d ? [d.lat, d.lng] : null;
    };

    return (
        <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
            
            {/* SIDEBAR DASHBOARD */}
            <div style={{ width: '300px', background: '#f8f9fa', padding: '20px', overflowY: 'auto', borderRight: '2px solid #ddd' }}>
                <h2>📦 Logistics Hub</h2>
                <div style={{ marginBottom: '20px' }}>
                    <strong>Stats:</strong><br/>
                    Active Orders: {activeOrders.length}<br/>
                    Drivers Online: {drivers.length}
                </div>
                
                <h3>Active Deliveries</h3>
                {activeOrders.length === 0 && <p style={{color: '#888'}}>No active orders.</p>}
                
                <ul style={{ listStyle: 'none', padding: 0 }}>
                    {activeOrders.map(order => (
                        <li key={order.id} style={{ background: 'white', padding: '10px', marginBottom: '10px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', borderLeft: '5px solid #28a745' }}>
                            <strong>#{order.id} - {order.customer_name}</strong><br/>
                            <small>{order.item}</small><br/>
                            <small style={{color: '#666'}}>Driver: {order.driverId}</small>
                        </li>
                    ))}
                </ul>
            </div>

            {/* MAP AREA */}
            <div style={{ flex: 1, position: 'relative' }}>
                <MapContainer center={[51.505, -0.09]} zoom={12} style={{ height: "100%", width: "100%" }}>
                    <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                    
                    {/* WAREHOUSES */}
                    {warehouses.map(w => (
                        <Marker key={`wh-${w.id}`} position={[w.lat, w.lng]} icon={icons.gold}>
                            <Popup>🏭 {w.name}</Popup>
                        </Marker>
                    ))}

                    {/* DRIVERS */}
                    {drivers.map(d => (
                        <Marker key={d.id} position={[d.lat, d.lng]} icon={d.status === "IDLE" ? icons.blue : icons.green}>
                            <Popup>{d.id} <br/> {d.status}</Popup>
                        </Marker>
                    ))}

                    {/* ACTIVE ORDERS & LINES */}
                    {activeOrders.map(order => {
                        const driverPos = getDriverPos(order.driverId);
                        return (
                            <React.Fragment key={`order-group-${order.id}`}>
                                {/* Customer Pin */}
                                <Marker position={[order.lat, order.lng]} icon={icons.red}>
                                    <Popup>Order #{order.id} for {order.customer_name}</Popup>
                                </Marker>

                                {/* The Line: Driver -> Customer */}
                                {driverPos && (
                                    <Polyline 
                                        positions={[driverPos, [order.lat, order.lng]]} 
                                        pathOptions={{ color: 'blue', dashArray: '10, 10', weight: 2 }} 
                                    />
                                )}
                            </React.Fragment>
                        );
                    })}

                    <LocationMarker setModalOpen={setModalOpen} setTempCoords={setTempCoords} />
                </MapContainer>

                {/* FORM MODAL */}
                {modalOpen && (
                    <div style={{
                        position: 'absolute', top: '20%', left: '30%', backgroundColor: 'white', 
                        padding: '20px', zIndex: 1000, borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                    }}>
                        <h3>Create Order</h3>
                        <form onSubmit={handleOrder}>
                            <input name="name" placeholder="Name" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} required style={{ display:'block', marginBottom: 10 }} />
                            <input name="item" placeholder="Item" value={formData.item} onChange={e => setFormData({...formData, item: e.target.value})} required style={{ display:'block', marginBottom: 10 }} />
                            <button type="submit">Place Order</button>
                            <button type="button" onClick={() => setModalOpen(false)} style={{ marginLeft: 10 }}>Cancel</button>
                        </form>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Map;