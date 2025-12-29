// backend/config/db.js
const { Sequelize, DataTypes } = require('sequelize');

// Connect to the Docker Postgres container
const sequelize = new Sequelize('delivery_db', 'admin', 'password123', {
    host: 'localhost',
    dialect: 'postgres',
    logging: false, // Turn off console logging for clean output
});

// Define the Order Model
const Order = sequelize.define('Order', {
    customer_name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    item: {
        type: DataTypes.STRING,
        allowNull: false
    },
    driver_id: {
        type: DataTypes.STRING
    },
    status: {
        type: DataTypes.ENUM('ASSIGNED', 'PICKED_UP', 'DELIVERED'),
        defaultValue: 'ASSIGNED'
    },
    delivery_lat: DataTypes.FLOAT,
    delivery_lng: DataTypes.FLOAT
});

// Sync database (Create table if not exists)
const connectDB = async () => {
    try {
        await sequelize.authenticate();
        await sequelize.sync(); // Creates the table automatically
        console.log('✅ PostgreSQL Connected & Synced');
    } catch (error) {
        console.error('❌ Database Connection Error:', error);
    }
};

module.exports = { sequelize, Order, connectDB };