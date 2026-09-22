FROM node:24.21.0-alpine AS web-build
WORKDIR /src/web
RUN npm install --global pnpm@11.21.0
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM golang:1.27.1-alpine AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY examples/ ./examples/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /hooklane ./cmd/api
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /receiver ./examples/receiver

FROM alpine:3.24 AS runtime-base
RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 hooklane \
    && adduser -S -D -H -u 10001 -G hooklane hooklane
WORKDIR /app
USER 10001:10001

FROM runtime-base AS receiver
COPY --from=go-build /receiver /usr/local/bin/receiver
EXPOSE 8099
ENTRYPOINT ["receiver"]

FROM runtime-base AS app
COPY --from=go-build /hooklane /usr/local/bin/hooklane
COPY --from=web-build /src/web/dist/ /app/web/
ENV HTTP_ADDR=0.0.0.0:8088 WEB_DIR=/app/web
USER 10001:10001
EXPOSE 8088
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=3 \
    CMD wget -q -T 3 -O /dev/null http://127.0.0.1:8088/readyz || exit 1
ENTRYPOINT ["hooklane"]
