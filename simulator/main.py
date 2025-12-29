# simulator/main.py
import time
import random
import requests
import redis
import json
import math

# Configuration
BACKEND_URL = "http://localhost:4000"
NUM_DRIVERS = 50 
UPDATE_INTERVAL = 1

r_client = redis.Redis(host='localhost', port=6379, decode_responses=True)

class Driver:
    def __init__(self, driver_id):
        self.id = driver_id
        self.lat = 51.505 + random.uniform(-0.05, 0.05)
        self.lng = -0.09 + random.uniform(-0.05, 0.05)
        self.status = "IDLE" # Source of Truth
        self.target = None
        self.customer_loc = None
        self.order_id = None
        self.pickup_timer = 0

    def move_towards(self, target_lat, target_lng, speed=0.005): 
        d_lat = target_lat - self.lat
        d_lng = target_lng - self.lng
        distance = math.sqrt(d_lat**2 + d_lng**2)

        if distance < speed:
            self.lat = target_lat
            self.lng = target_lng
            return True
        else:
            ratio = speed / distance
            self.lat += d_lat * ratio
            self.lng += d_lng * ratio
            return False

    def update(self):
        # 1. IDLE: Check for Missions
        if self.status == "IDLE":
            try:
                mission_data = r_client.get(f"mission:{self.id}")
                if mission_data:
                    mission = json.loads(mission_data)
                    print(f"⚡ {self.id} accepted Order #{mission['orderId']}")
                    
                    self.status = "TO_WAREHOUSE"
                    self.target = mission['warehouse']
                    self.customer_loc = mission['customer']
                    self.order_id = mission['orderId']
                    
                    r_client.delete(f"mission:{self.id}")
                else:
                    self.lat += random.uniform(-0.0005, 0.0005)
                    self.lng += random.uniform(-0.0005, 0.0005)
            except Exception as e:
                print(f"Redis Error: {e}")

        # 2. TO WAREHOUSE
        elif self.status == "TO_WAREHOUSE":
            if self.move_towards(self.target['lat'], self.target['lng']):
                self.status = "PICKUP"
                self.pickup_timer = time.time()

        # 3. PICKUP
        elif self.status == "PICKUP":
            if time.time() - self.pickup_timer > 3: 
                self.status = "TO_CUSTOMER"
                self.target = self.customer_loc

        # 4. TO CUSTOMER
        elif self.status == "TO_CUSTOMER":
            if self.move_towards(self.target['lat'], self.target['lng']):
                print(f"✅ {self.id} DELIVERED Order #{self.order_id}")
                
                # Notify Backend (just for DB update)
                try:
                    requests.post(f"{BACKEND_URL}/api/orders/finish", json={
                        "orderId": self.order_id,
                        "driverId": self.id
                    }, timeout=2)
                except:
                    pass

                self.status = "IDLE"
                self.target = None
                self.order_id = None

    def to_dict(self):
        return {"id": self.id, "lat": self.lat, "lng": self.lng, "status": self.status}

drivers = [Driver(f"driver_{i}") for i in range(NUM_DRIVERS)]
print(f"🚗 Simulator running with {NUM_DRIVERS} drivers...")

while True:
    try:
        # Broadcast Status: "I am IDLE" or "I am BUSY"
        # This overwrites any stuck state in the Backend
        data = [d.to_dict() for d in drivers]
        requests.post(f"{BACKEND_URL}/api/driver-locations", json={"drivers": data}, timeout=1)
        
        for d in drivers: d.update()
        
    except KeyboardInterrupt:
        break
    except Exception:
        pass
    
    time.sleep(UPDATE_INTERVAL)