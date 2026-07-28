import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON request bodies
app.use(express.json());

// Basic GET route
app.get('/', (req, res) => {
    res.send('Server is up and running!');
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});