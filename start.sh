#!/usr/bin/env sh

ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
cd "$ROOT" || exit 1

if [ ! -d "$ROOT/node_modules" ]; then
    echo "[1/3] Installing dependencies..."
    if ! npm install; then
        echo "Failed to install dependencies." >&2
        exit 1
    fi
fi

echo "[2/3] Building frontend..."
if ! npm run build; then
    echo "Build failed." >&2
    exit 1
fi

echo "[3/3] Launching..."
exec npm run app
