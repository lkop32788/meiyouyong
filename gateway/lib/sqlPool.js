'use strict';

/**
 * MySQL/MariaDB connection pool (mysql2/promise).
 *
 * Replaces the former mssql/SQL Server pool. The database is the same
 * omnichannel schema that Laravel migrates (see backend/database/migrations).
 * Pool is lazy-singleton; first query establishes connections.
 */

const mysql = require('mysql2/promise');

let _pool = null;

function getSqlPool() {
    if (_pool) return _pool;

    _pool = mysql.createPool({
        host:               process.env.DB_HOST     || '127.0.0.1',
        port:               parseInt(process.env.DB_PORT || '3306', 10),
        database:           process.env.DB_DATABASE || 'omnichannel',
        user:               process.env.DB_USERNAME || 'omniclick',
        password:           process.env.DB_PASSWORD || '',
        waitForConnections: true,
        connectionLimit:    10,
        maxIdle:            2,
        idleTimeout:        30_000,
        charset:            'utf8mb4',
        // Laravel stores UTC timestamps
        timezone:           'Z',
        enableKeepAlive:    true,
    });

    _pool.on('error', (err) => {
        console.error('MySQL pool error:', err.message);
        _pool = null;
    });

    return _pool;
}

module.exports = { getSqlPool };
