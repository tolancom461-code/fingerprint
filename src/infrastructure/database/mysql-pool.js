import mysql from 'mysql2/promise';

export function createBiometricDatabasePool(config) {
  if (!config) throw new Error('database config is required');

  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: 'utf8mb4_bin',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ssl: config.sslMode === 'required'
      ? { minVersion: 'TLSv1.2', rejectUnauthorized: true }
      : undefined
  });
}
