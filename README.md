# Simple Replit

IDE simples no navegador (estilo Replit) feito para editar e rodar código do projeto **Premercado / Agente de Análise** na sua VPS.

## O que tem no MVP

- Editor Monaco (mesmo do VS Code)
- Explorador de arquivos (criar, renomear, deletar, pastas)
- Rodar **Python** e **JavaScript**
- Console de saída
- Salvar arquivos
- Tema dark
- Atalhos: `Ctrl+S` (salvar) e `Ctrl+Enter` (rodar)
- Suporte a monorepos grandes (ignora `node_modules`, `.git`, etc.)
- **Git integrado**: Status, Pull, Commit e Push direto pela interface

## Como usar na VPS (Opção 3)

### 1. Clone ou atualize o Premercado

```bash
cd /caminho/onde/fica
git clone https://github.com/haohmarusc-glitch/Premercado.git
# ou se já tiver:
cd Premercado && git pull
```

### 2. Instale e rode o Simple Replit apontando para o Premercado

```bash
cd simple-replit
npm install

# Aponta o workspace para a pasta do Premercado
WORKSPACE_PATH=/caminho/completo/para/Premercado PORT=3000 node server.js
```

Exemplo real:

```bash
WORKSPACE_PATH=/home/seuusuario/Premercado PORT=3080 node server.js
```

### 3. Acesse no navegador

```
http://IP-DA-SUA-VPS:3080
```

Agora o explorador de arquivos vai mostrar o código do Premercado e você pode editar, salvar e rodar scripts Python/JS diretamente.

## Desenvolvimento local

```bash
npm install
npm start
# abre http://localhost:3000
# usa a pasta ./workspace por padrão
```

## Variáveis de ambiente

| Variável          | Descrição                                                        | Padrão              |
|-------------------|-------------------------------------------------------------------|---------------------|
| `AUTH_TOKEN`      | **Obrigatório em VPS exposta.** Sem ele a API roda sem auth. Gere com `openssl rand -hex 32`. | *(vazio = sem auth)* |
| `ALLOWED_ORIGINS` | Domínios/IPs aceitos por CORS, separados por vírgula             | *(vazio = só localhost)* |
| `PORT`            | Porta do servidor                                                | `3000`              |
| `WORKSPACE_PATH`  | Caminho absoluto da pasta do projeto a editar                    | `./workspace`       |
| `BACKUP_PATH`     | Pasta onde ficam os backups `.tar.gz`                            | `./backups`         |
| `SHELL_MODE`      | `open` remove a whitelist do `/api/shell` — só temporariamente   | *(vazio = whitelist)* |

Veja `.env.example` para copiar e preencher.

## Segurança

- `runGit` usa `spawn` com array de argumentos (**sem shell**) — evita RCE via mensagem de commit ou paths.
- CORS sem `ALLOWED_ORIGINS` libera apenas `localhost` / `127.0.0.1`.
- Nomes de arquivo escapados no frontend (`escapeHtml`) antes de `innerHTML`.
- Shell com whitelist por padrão (`SHELL_MODE` vazio).

## Próximas melhorias possíveis

- Multi-root / vários projetos
- Stage seletivo no commit UI
- Terminal PTY interativo (node-pty)
