# syntax=docker/dockerfile:1
ARG NPM_TOKEN
FROM node:latest AS build
WORKDIR /src
ENV API_SECRET=baked-in-secret-value
RUN curl -fsSL https://example.com/install.sh | sh
ADD https://example.com/archive.tgz /tmp/archive.tgz
COPY . .
RUN npm ci && \
    npm run build

FROM debian:12@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
COPY --from=build /src/dist /app
EXPOSE 8080 9090/tcp
CMD ["/app/server"]
