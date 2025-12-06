
import { loadEnv } from 'vite';
import path from 'path';

const env = loadEnv('test', path.resolve(__dirname, '../../'), '');
console.log('DATABASE_URL:', env.DATABASE_URL);
