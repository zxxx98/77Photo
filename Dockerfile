# Build the browser bundle first, then embed it in a CGO-free Go binary.
FROM node:22-alpine AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

FROM golang:1.23-alpine AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
COPY --from=web-build /src/web/dist/ ./internal/webassets/static/
ARG TARGETOS=linux
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/77photo ./cmd/77photo

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget \
    && addgroup -S 77photo \
    && adduser -S -D -H -G 77photo 77photo \
    && mkdir -p /data/photos /data/cache /data/database \
    && chown -R 77photo:77photo /data
WORKDIR /app
COPY --from=go-build /out/77photo /app/77photo
ENV PHOTO_DATA_DIR=/data/photos \
    PHOTO_CACHE_DIR=/data/cache \
    PHOTO_DB_PATH=/data/database/77photo.db \
    PHOTO_LISTEN_ADDR=:8080 \
    PHOTO_THUMBNAIL_WORKERS=1
USER 77photo
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/app/77photo"]
