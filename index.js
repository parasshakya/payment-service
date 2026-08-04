import 'dotenv/config'; // Loads .env into process.env automatically
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import {
  initDb,
  saveOrder,
  updateKhaltiOrderStatus,
  updateEsewaOrderStatus,
  getAllOrders,
} from './db.js';

const app = express();

// Middleware to parse incoming JSON requests
app.use(express.json());

// Load configurations from environment variables with fallbacks
const PORT = process.env.PORT || 3000;
const KHALTI_SECRET_KEY = process.env.KHALTI_SECRET_KEY;
const KHALTI_BASE_URL = process.env.KHALTI_BASE_URL;

// Sanity check for environment configuration
if (!KHALTI_SECRET_KEY || !KHALTI_BASE_URL) {
  console.error('❌ CRITICAL ERROR: KHALTI_SECRET_KEY or KHALTI_BASE_URL is missing in environment variables!');
  process.exit(1); // Stops the server from starting up with invalid configuration
}

// Initialize PostgreSQL Database Table
initDb();

/**
 * 1. KHALTI INITIATE PAYMENT ENDPOINT
 * Receives payment details from Flutter and requests a `pidx` from Khalti
 */
app.post('/api/khalti/initiate', async (req, res) => {
  try {
    const { amount, purchase_order_id, purchase_order_name, customer_info } = req.body;

    // Validation
    if (!amount || !purchase_order_id || !purchase_order_name) {
      console.log('⚠️ Khalti Initiation validation failed:', {
        amount,
        purchase_order_id,
        purchase_order_name,
      });

      return res.status(400).json({
        success: false,
        error: 'Missing required fields: amount, purchase_order_id, purchase_order_name',
      });
    }

    const serverBaseUrl = process.env.SERVER_BASE_URL;

    // Construct Khalti Initiation Payload
    const payload = {
      return_url: `${serverBaseUrl}/api/khalti/callback`, // GET callback after user completes payment
      website_url: 'https://example.com/',
      amount: Math.round(amount * 100), // Converts NPR to Paisa (1 NPR = 100 Paisa)
      purchase_order_id,
      purchase_order_name,
      customer_info: customer_info || {},
    };

    // Call Khalti ePayment Initiate API
    const response = await axios.post(`${KHALTI_BASE_URL}/epayment/initiate/`, payload, {
      headers: {
        Authorization: KHALTI_SECRET_KEY.startsWith('Key ') || KHALTI_SECRET_KEY.startsWith('key ')
          ? KHALTI_SECRET_KEY
          : `Key ${KHALTI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('✅ Khalti Initiation Successful:', response.data);

    // Save initial transaction state in PostgreSQL
    await saveOrder({
      order_id: purchase_order_id,
      gateway: 'KHALTI',
      amount,
      status: 'PENDING',
      pidx: response.data.pidx,
      customer_info: customer_info || {},
    });

    // Append return_url as a query param to payment_url for Flutter SDK interception
    const paymentUrlWithReturn =
      `${response.data.payment_url}&return_url=${encodeURIComponent(payload.return_url)}`;

    // Send successful response containing `pidx` and `payment_url` back to Flutter
    return res.status(200).json({
      success: true,
      data: {
        ...response.data,
        payment_url: paymentUrlWithReturn,
      },
    });
  } catch (error) {
    console.error('Khalti Initiation Error:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

/**
 * 2. KHALTI VERIFY / LOOKUP PAYMENT ENDPOINT
 * Receives `pidx` from Flutter to verify transaction status with Khalti
 */
app.post('/api/khalti/verify', async (req, res) => {
  try {
    const { pidx } = req.body;

    if (!pidx) {
      console.log('⚠️ Khalti Verification validation failed: missing pidx', {
        body: req.body,
      });

      return res.status(400).json({
        success: false,
        error: 'pidx parameter is required for verification',
      });
    }

    // Call Khalti ePayment Lookup API
    const response = await axios.post(
      `${KHALTI_BASE_URL}/epayment/lookup/`,
      { pidx },
      {
        headers: {
          Authorization: KHALTI_SECRET_KEY.startsWith('Key ') || KHALTI_SECRET_KEY.startsWith('key ')
            ? KHALTI_SECRET_KEY
            : `Key ${KHALTI_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const isCompleted = response.data.status === 'Completed';
    const status = isCompleted ? 'COMPLETED' : (response.data.status || 'FAILED');
    const transactionId = response.data.transaction_id || response.data.idx || null;

    // Update order status in PostgreSQL
    await updateKhaltiOrderStatus(pidx, status, transactionId);

    if (isCompleted) {
      console.log('✅ Khalti Verification Successful:', response.data);

      return res.status(200).json({
        success: true,
        message: 'Payment verified successfully',
        data: response.data,
      });
    }

    console.log('⚠️ Khalti Verification returned non-completed status:', response.data.status, response.data);

    return res.status(400).json({
      success: false,
      message: `Payment status is ${response.data.status}`,
      data: response.data,
    });
  } catch (error) {
    console.error('Khalti Verification Error:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

/**
 * 3. KHALTI BROWSER REDIRECT CALLBACK ENDPOINT (Web Integration)
 * Khalti redirects the user's browser here after payment via GET with query params:
 * ?pidx=...&status=Completed&transaction_id=...&amount=...&mobile=...&purchase_order_id=...
 *
 * Note: In Flutter SDK integration, this URL is intercepted by the SDK and never
 * actually hit as an HTTP request. This handler is for web-based integrations.
 */
app.get('/api/khalti/callback', async (req, res) => {
  const { pidx, status, transaction_id, amount, purchase_order_id } = req.query;

  console.log('🔔 Khalti Browser Callback Received:', req.query);

  if (!pidx) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Payment Error</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;">
          <h2 style="color:#dc3545;">❌ Invalid Callback</h2>
          <p>Missing payment identifier (pidx). Please contact support.</p>
        </body>
      </html>
    `);
  }

  // Handle user-canceled payment without calling Lookup API
  if (status === 'User canceled') {
    await updateKhaltiOrderStatus(pidx, 'CANCELED', null);
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Payment Canceled</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f7f9fc;}.card{background:white;padding:30px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);display:inline-block;}</style>
        </head>
        <body>
          <div class="card">
            <h2 style="color:#6c757d;">Payment Canceled</h2>
            <p>You canceled the payment. You may return to the app and try again.</p>
          </div>
        </body>
      </html>
    `);
  }

  try {
    // Call Khalti Lookup API to verify the actual payment status
    const lookupResponse = await axios.post(
      `${KHALTI_BASE_URL}/epayment/lookup/`,
      { pidx },
      {
        headers: {
          Authorization: KHALTI_SECRET_KEY.startsWith('Key ') || KHALTI_SECRET_KEY.startsWith('key ')
            ? KHALTI_SECRET_KEY
            : `Key ${KHALTI_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const isCompleted = lookupResponse.data.status === 'Completed';
    const verifiedStatus = isCompleted ? 'COMPLETED' : (lookupResponse.data.status || 'FAILED');
    const verifiedTxnId = lookupResponse.data.transaction_id || lookupResponse.data.idx || null;

    // Update order status in PostgreSQL
    await updateKhaltiOrderStatus(pidx, verifiedStatus, verifiedTxnId);

    if (isCompleted) {
      console.log('✅ Khalti Callback Verification Successful:', lookupResponse.data);
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
          <head><title>Payment Successful</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f7f9fc;}.card{background:white;padding:30px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);display:inline-block;}</style>
          </head>
          <body>
            <div class="card">
              <h2 style="color:#28a745;">✅ Payment Successful!</h2>
              <p>Order <strong>${purchase_order_id || pidx}</strong> has been confirmed.</p>
              <p>Transaction ID: <code>${verifiedTxnId || transaction_id || 'N/A'}</code></p>
              <p>You may close this window and return to the app.</p>
            </div>
          </body>
        </html>
      `);
    }

    console.log('⚠️ Khalti Callback: non-completed status:', lookupResponse.data.status);
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Payment Failed</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f7f9fc;}.card{background:white;padding:30px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);display:inline-block;}</style>
        </head>
        <body>
          <div class="card">
            <h2 style="color:#dc3545;">❌ Payment Failed</h2>
            <p>Status: <strong>${lookupResponse.data.status}</strong></p>
            <p>Please try again or contact support.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('❌ Khalti Callback Lookup Error:', error.response?.data || error.message);
    return res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Verification Error</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;">
          <h2 style="color:#dc3545;">⚠️ Verification Error</h2>
          <p>Could not verify payment status. Please contact support with your order ID.</p>
        </body>
      </html>
    `);
  }
});

/**
 * 4. ESEWA INITIATE / BOOK PAYMENT ENDPOINT
 */
app.post('/api/esewa/initiate', async (req, res) => {
  try {
    const { amount, purchase_order_id } = req.body;

    if (!amount) {
      console.log('⚠️ eSewa Initiation validation failed: missing amount');
      return res.status(400).json({
        success: false,
        error: 'Missing required field: amount',
      });
    }

    const product_code = process.env.ESEWA_PRODUCT_CODE || 'INTENT';
    const secret_key = process.env.ESEWA_SECRET_KEY || 'LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==';
    const transaction_uuid = purchase_order_id || `txn-${Date.now()}`;
    const formattedAmount = String(amount);

    const message = `product_code=${product_code},amount=${formattedAmount},transaction_uuid=${transaction_uuid}`;
    const hash = crypto.createHmac('sha256', secret_key).update(message).digest('base64');

    const serverBaseUrl = process.env.SERVER_BASE_URL || `http://localhost:${PORT}`;
    const callback_url = `${serverBaseUrl}/api/esewa/callback`;
    const redirect_url = `${serverBaseUrl}/api/esewa/redirect`;

    const payload = {
      product_code,
      amount: Number(amount),
      transaction_uuid,
      signed_field_names: 'product_code,amount,transaction_uuid',
      signature: hash,
      callback_url,
      redirect_url,
      properties: {
        customer_id: 'CUST123',
        remarks: 'Payment Demo',
      },
    };

    const response = await axios.post(
      'https://rc-checkout.esewa.com.np/api/client/intent/payment/book',
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );

    console.log('✅ eSewa Initiation Successful:', response.data);

    const bookingData = response.data?.data || {};

    // Save initial transaction state in PostgreSQL
    await saveOrder({
      order_id: transaction_uuid,
      gateway: 'ESEWA',
      amount,
      status: 'BOOKED',
      booking_id: bookingData.booking_id,
      correlation_id: bookingData.correlation_id,
    });

    return res.status(200).json({
      success: true,
      data: bookingData,
      transaction_uuid,
    });
  } catch (error) {
    console.error('❌ eSewa Initiation Error:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

/**
 * 4. ESEWA WEBHOOK / CALLBACK ENDPOINT (Server-to-Server)
 */
app.post('/api/esewa/callback', async (req, res) => {
  console.log('🔔 eSewa Webhook / Callback Received:', req.body);

  const { booking_id, status, transaction_id, reference_code } = req.body || {};

  if (booking_id) {
    const updatedStatus = status === 'SUCCESS' || status === 'COMPLETED' ? 'SUCCESS' : (status || 'FAILED');
    await updateEsewaOrderStatus(booking_id, updatedStatus, transaction_id, reference_code);
  }

  return res.status(200).json({
    success: true,
    message: 'Webhook received successfully',
  });
});

/**
 * 5. ESEWA REDIRECT ENDPOINT (Browser/App Redirect)
 */
app.all('/api/esewa/redirect', (req, res) => {
  console.log('🔄 eSewa Redirect Triggered:', {
    query: req.query,
    body: req.body,
  });

  return res.status(200).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Payment Redirect</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; text-align: center; padding: 50px; background-color: #f7f9fc; }
          .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: inline-block; }
          h2 { color: #28a745; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Payment Processed</h2>
          <p>Thank you! You may close this window and return to your app.</p>
        </div>
      </body>
    </html>
  `);
});

/**
 * 6. ESEWA STATUS CHECK / VERIFY ENDPOINT
 */
app.post('/api/esewa/verify', async (req, res) => {
  try {
    const { booking_id, correlation_id } = req.body;

    if (!booking_id || !correlation_id) {
      console.log('⚠️ eSewa Verification validation failed:', { booking_id, correlation_id });
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: booking_id and correlation_id are required',
      });
    }

    const product_code = process.env.ESEWA_PRODUCT_CODE || 'INTENT';
    const secret_key = process.env.ESEWA_SECRET_KEY || 'LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==';

    const message = `booking_id=${booking_id},product_code=${product_code},correlation_id=${correlation_id}`;
    const hash = crypto.createHmac('sha256', secret_key).update(message).digest('base64');

    const payload = {
      booking_id,
      product_code,
      correlation_id,
      signed_field_names: 'booking_id,product_code,correlation_id',
      signature: hash,
    };

    const response = await axios.post(
      'https://rc-checkout.esewa.com.np/api/client/intent/payment/status',
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );

    const data = response.data?.data || {};
    const isSuccess = data.status === 'SUCCESS';
    const dbStatus = isSuccess ? 'SUCCESS' : (data.status || 'FAILED');

    // Update order status in PostgreSQL
    await updateEsewaOrderStatus(booking_id, dbStatus, data.transaction_id, data.reference_code);

    if (isSuccess) {
      console.log('✅ eSewa Verification Successful:', response.data);
    } else {
      console.log('⚠️ eSewa Verification returned non-success status:', data.status, response.data);
    }

    return res.status(isSuccess ? 200 : 400).json({
      success: isSuccess,
      message: response.data?.message || `Payment status is ${data.status}`,
      data: data,
    });
  } catch (error) {
    console.error('❌ eSewa Verification Error:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

/**
 * 7. GET ALL ORDERS HISTORY ENDPOINT
 */
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await getAllOrders();
    return res.status(200).json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Root route for server health check
app.get('/', (req, res) => {
  console.log('ℹ️  Health check passed');
  res.status(200).json({
    success: true,
    message: 'Server is up and running successfully! 🚀',
  });
});

// Fallback route handler for undefined endpoints
app.use((req, res) => {
  console.log('⚠️  Route not found:', req.method, req.originalUrl);
  res.status(404).json({ success: false, error: 'Route not found' });
});

// Start listening for requests
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});