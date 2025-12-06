-- Initialize additional databases for Synap services
-- This script runs automatically when the container starts

-- Create database for Ory Kratos and Hydra
-- We use a single database 'ory' for both, or separate if preferred.
-- The plan mentioned 'ory' and 'hydra' databases. Let's create both to be flexible.

CREATE DATABASE ory;
CREATE DATABASE hydra;
CREATE DATABASE mem0;

\echo 'Additional databases created: ory, hydra, mem0'
