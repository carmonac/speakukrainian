# The Firestore emulator is a Java program, so the image needs a JRE alongside
# Node. Baking firebase-tools in keeps container start fast — installing it at
# run time cost about a minute on every `docker compose up`.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends default-jre-headless wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g firebase-tools@14

# Pre-download the emulator jars so the first start is not a silent 30s fetch.
RUN firebase setup:emulators:firestore \
  && firebase setup:emulators:ui

WORKDIR /workspace
EXPOSE 8081 9099 4001
