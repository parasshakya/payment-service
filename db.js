import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// Configure PostgreSQL Pool connection
const poolConfig = process.env.DATABASE_URL
  ? {
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_URL.includes('neon.tech') ||
        process.env.DATABASE_URL.includes('sslmode=require') ||
        process.env.DATABASE_URL.includes('ssl=true')
        ? { rejectUnauthorized: false }
        : false,
  }
  : {
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: Number(process.env.PGPORT)
  };

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL pool error:', err.message);
});

/**
 * Initialize database tables
 */
export async function initDb() {
  const queryText = `
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(100) UNIQUE NOT NULL,
      gateway VARCHAR(20) NOT NULL,
      pidx VARCHAR(100),
      booking_id VARCHAR(100),
      correlation_id VARCHAR(100),
      amount NUMERIC(10, 2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      transaction_id VARCHAR(100),
      reference_code VARCHAR(100),
      customer_info JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await pool.query(queryText);
    console.log('✅ PostgreSQL Database & "orders" table initialized.');
  } catch (error) {
    console.warn('⚠️ Database initialization warning (Make sure PostgreSQL is running):', error.message);
  }
}

/**
 * Save a new order to the database
 */
export async function saveOrder({
  order_id,
  gateway,
  amount,
  status = 'PENDING',
  pidx = null,
  booking_id = null,
  correlation_id = null,
  customer_info = null,
}) {
  const queryText = `
    INSERT INTO orders (order_id, gateway, amount, status, pidx, booking_id, correlation_id, customer_info)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (order_id) DO UPDATE SET
      status = EXCLUDED.status,
      pidx = COALESCE(EXCLUDED.pidx, orders.pidx),
      booking_id = COALESCE(EXCLUDED.booking_id, orders.booking_id),
      correlation_id = COALESCE(EXCLUDED.correlation_id, orders.correlation_id),
      updated_at = CURRENT_TIMESTAMP
    RETURNING *;
  `;

  const values = [
    order_id,
    gateway,
    amount,
    status,
    pidx,
    booking_id,
    correlation_id,
    customer_info ? JSON.stringify(customer_info) : null,
  ];

  try {
    const res = await pool.query(queryText, values);
    return res.rows[0];
  } catch (error) {
    console.error('❌ Error saving order to PostgreSQL:', error.message);
    return null;
  }
}

/**
 * Update payment status by pidx (Khalti)
 */
export async function updateKhaltiOrderStatus(pidx, status, transactionId = null) {
  const queryText = `
    UPDATE orders
    SET status = $1,
        transaction_id = COALESCE($2, transaction_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE pidx = $3
    RETURNING *;
  `;
  try {
    const res = await pool.query(queryText, [status, transactionId, pidx]);
    return res.rows[0];
  } catch (error) {
    console.error('❌ Error updating Khalti order status:', error.message);
    return null;
  }
}

/**
 * Update payment status by booking_id (eSewa)
 */
export async function updateEsewaOrderStatus(bookingId, status, transactionId = null, referenceCode = null) {
  const queryText = `
    UPDATE orders
    SET status = $1,
        transaction_id = COALESCE($2, transaction_id),
        reference_code = COALESCE($3, reference_code),
        updated_at = CURRENT_TIMESTAMP
    WHERE booking_id = $4
    RETURNING *;
  `;
  try {
    const res = await pool.query(queryText, [status, transactionId, referenceCode, bookingId]);
    return res.rows[0];
  } catch (error) {
    console.error('❌ Error updating eSewa order status:', error.message);
    return null;
  }
}

/**
 * Get all orders
 */
export async function getAllOrders() {
  try {
    const res = await pool.query('SELECT * FROM orders ORDER BY created_at DESC;');
    return res.rows;
  } catch (error) {
    console.error('❌ Error fetching orders:', error.message);
    return [];
  }
}
