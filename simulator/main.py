# simulator/main.py
import time
import random
import requests
import redis
import json
import polyline

# --- CONFIGURATION ---
BACKEND_URL = "http://localhost:4000"
NUM_DRIVERS = 20
UPDATE_INTERVAL = 1.0  # Seconds between ticks
OSRM_URL = "http://router.project-osrm.org/route/v1/driving"

# Connect to Redis
r_client = redis.Redis(host='localhost', port=6379, decode_responses=True)

def get_route(start_lat, start_lng, end_lat, end_lng):
    """
    Fetches a driving route from OSRM.
    Returns a list of [lat, lng] tuples.
    """
    try:
        # Request full geometry
        url = f"{OSRM_URL}/{start_lng},{start_lat};{end_lng},{end_lat}?overview=full"
        response = requests.get(url, timeout=2)
        
        if response.status_code == 200:
            data = response.json()
            if data.get('code') == 'Ok' and len(data.get('routes', [])) > 0:
                geometry = data['routes'][0]['geometry']
                # polyline.decode returns [(lat, lng), ...]
                return polyline.decode(geometry)
        return []
    except Exception as e:
        print(f"⚠️ Routing Failed: {e}")
        return []

class Driver:
    def __init__(self, driver_id):
        self.id = driver_id
        # Start somewhere in Central London
        self.lat = 51.505 + random.uniform(-0.02, 0.02)
        self.lng = -0.09 + random.uniform(-0.04, 0.04)
        
        self.status = "IDLE" 
        self.route_path = [] 
        self.path_index = 0
        
        # Mission details
        self.order_id = None
        self.customer_loc = None
        self.pickup_timer = 0

    def start_mission(self, target_lat, target_lng, mission_type):
        """
        Calculates route for a specific job (Pickup or Delivery) 
        AND notifies the frontend to draw the line.
        """
        print(f"🗺️ {self.id}: Starting {mission_type} mission...")
        
        path = get_route(self.lat, self.lng, target_lat, target_lng)
        
        # Fallback if routing fails: just jump to target
        if not path:
            path = [(target_lat, target_lng)]
        
        self.route_path = path
        self.path_index = 0

        # Broadcast the route geometry to the frontend for drawing
        try:
            requests.post(f"{BACKEND_URL}/api/driver-route", json={
                "driverId": self.id,
                "routePath": path,
                "type": mission_type, # 'pickup' or 'delivery'
                "orderId": self.order_id
            }, timeout=1)
        except Exception as e:
            print(f"Failed to send route visual: {e}")

    def wander(self):
        """
        Makes the driver move randomly when IDLE.
        Does NOT send route geometry to frontend (keeps map clean).
        """
        # If we are already moving on a wander path, keep going
        if self.route_path and self.path_index < len(self.route_path):
            self.move_along_path()
            return

        # Otherwise, pick a new random spot nearby (approx 1-2km)
        rand_lat = self.lat + random.uniform(-0.01, 0.01)
        rand_lng = self.lng + random.uniform(-0.01, 0.01)
        
        path = get_route(self.lat, self.lng, rand_lat, rand_lng)
        if path:
            self.route_path = path
            self.path_index = 0

    def move_along_path(self):
        """
        Advances the driver along the current route_path.
        Returns True if the destination is reached.
        """
        if self.path_index < len(self.route_path):
            # Speed factor: skip points to move faster
            # Increase this number to make drivers faster
            steps = 4 
            self.path_index = min(self.path_index + steps, len(self.route_path) - 1)
            
            next_point = self.route_path[self.path_index]
            self.lat = next_point[0]
            self.lng = next_point[1]
            
            # Check if we reached the end of the path
            if self.path_index >= len(self.route_path) - 1:
                return True
            return False
        return True

    def update(self):
        """
        Main logic loop for the driver.
        Checks for missions first, then executes movement.
        """
        
        # --- 1. PRIORITY: Check for New Missions ---
        # Even if wandering, we check if we got assigned a job
        if self.status == "IDLE":
            try:
                mission_data = r_client.get(f"mission:{self.id}")
                if mission_data:
                    mission = json.loads(mission_data)
                    self.order_id = mission['orderId']
                    self.status = "TO_WAREHOUSE"
                    
                    warehouse = mission['warehouse']
                    self.customer_loc = mission['customer'] # Save for later delivery leg

                    # Start routing to warehouse
                    self.start_mission(warehouse['lat'], warehouse['lng'], "pickup")
                    
                    # Remove mission from Redis so we don't pick it up again
                    r_client.delete(f"mission:{self.id}")
            except Exception as e:
                print(f"Error checking mission: {e}")

        # --- 2. STATE MACHINE ---
        
        if self.status == "IDLE":
            # No mission? Just drive around aimlessly
            self.wander()

        elif self.status == "TO_WAREHOUSE":
            # Driving to the warehouse
            if self.move_along_path():
                self.status = "PICKUP"
                self.pickup_timer = time.time()
                # Clear path so we stop moving while picking up
                self.route_path = []

        elif self.status == "PICKUP":
            # Simulating loading time (2 seconds)
            if time.time() - self.pickup_timer > 2:
                self.status = "TO_CUSTOMER"
                self.start_mission(self.customer_loc['lat'], self.customer_loc['lng'], "delivery")

        elif self.status == "TO_CUSTOMER":
            # Driving to the customer
            if self.move_along_path():
                print(f"✅ {self.id} DELIVERED Order #{self.order_id}")
                
                # Notify backend that order is done
                try:
                    requests.post(f"{BACKEND_URL}/api/orders/finish", 
                                  json={"orderId": self.order_id}, timeout=1)
                except Exception:
                    pass
                
                # Reset to IDLE
                self.status = "IDLE"
                self.route_path = [] 
                self.order_id = None

    def to_dict(self):
        return {
            "id": self.id, 
            "lat": self.lat, 
            "lng": self.lng, 
            "status": self.status
        }

# --- INITIALIZATION ---
print(f"🚗 Simulator starting with {NUM_DRIVERS} drivers...")
drivers = [Driver(f"driver_{i}") for i in range(NUM_DRIVERS)]

# --- MAIN LOOP ---
while True:
    try:
        # 1. Update all drivers (move, check missions)
        for d in drivers:
            d.update()

        # 2. Collect positions
        data = [d.to_dict() for d in drivers]

        # 3. Send batch update to Backend
        requests.post(f"{BACKEND_URL}/api/driver-locations", json={"drivers": data}, timeout=1)
        
    except KeyboardInterrupt:
        print("🛑 Simulator stopped.")
        break
    except Exception as e:
        print(f"Tick Error: {e}")
    
    time.sleep(UPDATE_INTERVAL)