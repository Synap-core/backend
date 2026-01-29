-- Create databases for services
SELECT 'CREATE DATABASE kratos' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'kratos');
SELECT 'CREATE DATABASE hydra' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hydra');
SELECT 'CREATE DATABASE synap' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'synap'); -- Should exist by default but safe to check
