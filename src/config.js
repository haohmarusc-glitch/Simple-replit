const path = require('path');
const fs = require('fs');

const WORKSPACE = process.env.WORKSPACE_PATH
  ? path.resolve(process.env.WORKSPACE_PATH)
  : path.join(__dirname, '..', 'workspace');

const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = (process.env.AUTH_TOKEN || '').trim();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SHELL_OPEN = process.env.SHELL_MODE === 'open';

// Detalhes de infraestrutura usados pelos workflows rápidos (/api/workflow).
// Configuráveis via env para não deixar nome de container/domínio de produção
// hardcoded num repo público; os defaults abaixo preservam o comportamento
// anterior para quem já usa a instalação padrão do Premercado.
const DB_CONTAINER_NAME = process.env.DB_CONTAINER_NAME || 'premercado-db-1';
const DB_USER = process.env.DB_USER || 'premercado';
const HEALTH_CHECK_HOST = process.env.HEALTH_CHECK_HOST || '';
const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || 'http://127.0.0.1/api/healthz';

const BACKUP_DIR = process.env.BACKUP_PATH
  ? path.resolve(process.env.BACKUP_PATH)
  : path.join(__dirname, '..', 'backups');

const IGNORE = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage',
  '__pycache__', '.temp', '.DS_Store', 'pnpm-lock.yaml', 'package-lock.json',
  'yarn.lock', '.agents', '.claude', '.github', '.docker'
]);

const ALLOWED_DOTFILES = new Set([
  '.env', '.env.example', '.env.local', '.gitignore', '.npmrc', '.dockerignore'
]);

if (!process.env.WORKSPACE_PATH && !fs.existsSync(WORKSPACE)) {
  fs.mkdirSync(WORKSPACE, { recursive: true });
}

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

module.exports = {
  WORKSPACE,
  PUBLIC,
  PORT,
  AUTH_TOKEN,
  ALLOWED_ORIGINS,
  SHELL_OPEN,
  BACKUP_DIR,
  IGNORE,
  ALLOWED_DOTFILES,
  DB_CONTAINER_NAME,
  DB_USER,
  HEALTH_CHECK_HOST,
  HEALTH_CHECK_URL,
};
