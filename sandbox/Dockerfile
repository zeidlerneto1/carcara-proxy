# Imagem leve para sandbox de execução de código
# Build: docker build -f sandbox/Dockerfile -t carcara-sandbox .

FROM python:3.11-alpine AS python-base
RUN apk add --no-cache nodejs npm

FROM node:20-alpine AS node-base
RUN apk add --no-cache python3 py3-pip

# Imagem final combinada (pequena)
FROM alpine:3.19
RUN apk add --no-cache     python3     py3-pip     nodejs     npm     bash     curl     && rm -rf /var/cache/apk/*

# Cria usuário não-root
RUN adduser -D -u 1000 sandbox
USER sandbox
WORKDIR /sandbox

# Pre-warm: instala tsx globalmente (para TypeScript)
RUN npm install -g tsx

CMD ["sh"]
