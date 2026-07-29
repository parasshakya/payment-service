import 'dotenv/config'; // Loads .env into process.env automatically
import express from 'express';
import axios from 'axios';

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

/**
 * 1. INITIATE PAYMENT ENDPOINT
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

    // Construct Khalti Initiation Payload
    const payload = {
      return_url: 'https://example.com/callback/', // Required dummy URL for mobile SDK/WebView
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

    // ✅ ADD THIS: Append return_url as a query param to payment_url
// The Flutter SDK reads return_url from paymentUrl's query parameters
// to know which URL to intercept in the WebView
const paymentUrlWithReturn =
  `${response.data.payment_url}&return_url=${encodeURIComponent(payload.return_url)}`;


    // Send successful response containing `pidx` and `payment_url` back to Flutter
    return res.status(200).json({
      success: true,
  data: {
    ...response.data,
    payment_url: paymentUrlWithReturn, // ← overrides with the enriched URL
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
 * 2. VERIFY / LOOKUP PAYMENT ENDPOINT
 * Receives `pidx` from Flutter to verify the transaction status with Khalti
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

    // Verify if the payment status is 'Completed'
    if (response.data.status === 'Completed') {
      // TODO: Perform database operations here (e.g., mark order as paid in MongoDB)
      console.log('✅ Khalti Verification Successful:', response.data);

      return res.status(200).json({
        success: true,
        message: 'Payment verified successfully',
        data: response.data,
      });
    }

    console.log('⚠️ Khalti Verification returned non-completed status:', response.data.status, response.data);

    // Handle non-completed statuses (e.g., Pending, User canceled, Expired)
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