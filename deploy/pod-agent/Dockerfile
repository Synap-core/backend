FROM node:20-alpine

WORKDIR /app

# No npm dependencies — just stdlib
COPY server.js .

# Non-root user (needs Docker socket access via group)
# The docker group GID is mapped at runtime via --group-add
USER node

EXPOSE 4002

CMD ["node", "server.js"]
