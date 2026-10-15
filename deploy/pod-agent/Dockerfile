FROM node:20-alpine

# Synap's own image: `synap tidy` removes a DANGLING image (a rebuild that took
# its tag) only when it carries this label — never another stack's image.
LABEL io.synap.first-party="true"

# Docker CLI + compose plugin + wget (for callbacks in shell scripts)
# + age: archive-pod.sh encrypts every archive before it leaves the host (D15)
RUN apk add --no-cache docker-cli docker-cli-compose wget age

WORKDIR /app
COPY server.js trust.js replay-receipts.js policy.js pod-identity.js pull.js package.json ./

EXPOSE 4002
CMD ["node", "server.js"]
