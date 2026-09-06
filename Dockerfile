# ---- build stage ----
FROM golang:1.22-alpine AS build
WORKDIR /src

# Copy go.mod first for layer caching
COPY backend-go/go.mod ./
COPY backend-go/ ./

RUN go build -o /sudoku-server .

# ---- runtime stage ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

# Compiled server binary
COPY --from=build /sudoku-server /app/sudoku-server

# Seed script: copies the baked puzzle pool into the volume on first boot
COPY backend-go/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Static frontend, served by the Go server at /
COPY frontend/ /frontend/

# Seed puzzle pool (used only to initialize the persistent volume on first boot)
COPY backend-go/data/puzzles.json /seed/puzzles.json

# The server must be started with the server subcommand; port 8090 matches fly.toml
EXPOSE 8090
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["server", "--port", "8090"]