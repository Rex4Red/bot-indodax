require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./src/database/db');
const apiRoutes = require('./src/routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
db.init();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', apiRoutes);

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║     🤖 INDODAX TRADING BOT v1.0         ║
║──────────────────────────────────────────║
║  Dashboard: http://localhost:${PORT}         ║
║  API:       http://localhost:${PORT}/api     ║
║──────────────────────────────────────────║
║  API Key:   ${process.env.INDODAX_API_KEY ? '✅ Loaded' : '❌ Missing'}                     ║
║  Secret:    ${process.env.INDODAX_SECRET_KEY ? '✅ Loaded' : '❌ Missing'}                     ║
╚══════════════════════════════════════════╝
    `);
});
