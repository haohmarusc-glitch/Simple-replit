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

module.exports = {
  WORKSPACE,
  PUBLIC,
  PORT,
  AUTH_TOKEN,
  ALLOWED_ORIGINS,
  SHELL_OPEN,
  IGNORE,
  ALLOWED_DOTFILES,
};
