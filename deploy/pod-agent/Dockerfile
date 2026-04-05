FROM node:20-alpine

# Docker CLI + compose plugin + wget (for callbacks in shell scripts)
RUN apk add --no-cache docker-cli docker-cli-compose wget

WORKDIR /app
COPY server.js .

EXPOSE 4002
CMD ["node", "server.js"]
