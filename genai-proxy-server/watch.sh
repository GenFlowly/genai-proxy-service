#!/bin/bash

# Function to get current checksum of source files based on modification time
get_checksum() {
    find src -type f \( -name "*.kt" -o -name "*.kts" -o -name "*.properties" -o -name "*.xml" -o -name "*.conf" -o -name "*.yaml" -o -name "*.yml" \) -exec stat -c "%Y" {} + 2>/dev/null | md5sum
}

# Function to start the application
start_app() {
    echo "Starting application..."
    gradle run --no-daemon &
    APP_PID=$!
}

# Function to stop the application
stop_app() {
    if [ ! -z "$APP_PID" ]; then
        echo "Stopping application (PID: $APP_PID)..."
        kill $APP_PID 2>/dev/null
        wait $APP_PID 2>/dev/null
    fi
}

# Handle cleanup on exit
trap stop_app SIGINT SIGTERM

echo "Starting poller..."
LAST_CHECKSUM=$(get_checksum)
start_app

while true; do
    sleep 2
    CURRENT_CHECKSUM=$(get_checksum)
    
    if [ "$CURRENT_CHECKSUM" != "$LAST_CHECKSUM" ]; then
        echo "Changes detected! Restarting application..."
        stop_app
        start_app
        LAST_CHECKSUM=$CURRENT_CHECKSUM
    fi
done
