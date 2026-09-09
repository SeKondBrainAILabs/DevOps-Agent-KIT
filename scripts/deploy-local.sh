#!/bin/bash

# Deploy DevOpsAgent locally to a target directory
# Usage: ./scripts/deploy-local.sh <target_directory>

TARGET_DIR="$1"

if [ -z "$TARGET_DIR" ]; then
  echo "Usage: $0 <target_directory>"
  exit 1
fi

if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: Target directory $TARGET_DIR does not exist"
  exit 1
fi

SOURCE_DIR="$(pwd)"
DEST_DIR="$TARGET_DIR/DevOpsAgent"

echo "Deploying DevOpsAgent to $DEST_DIR..."

# Create destination directory
mkdir -p "$DEST_DIR"

# Copy files
echo "Copying files..."
rsync -av --exclude 'node_modules' \
          --exclude '.git' \
          --exclude '.DS_Store' \
          --exclude 'local_deploy' \
          --exclude 'coverage' \
          --exclude 'test_cases' \
          "$SOURCE_DIR/" "$DEST_DIR/"

# Install dependencies in the target
echo "Installing dependencies in $DEST_DIR..."
cd "$DEST_DIR"
npm install --production --silent
cd "$SOURCE_DIR"

# Create universal runner script
RUNNER="$TARGET_DIR/devops"
LOG_FILE="$TARGET_DIR/devops-agent.log"

echo "Creating 'devops' CLI wrapper..."

cat > "$RUNNER" << EOF
#!/bin/bash

# DevOps Agent CLI Wrapper
# Supports all standard commands: start, chat, setup, worker, etc.

DIR="\$(cd "\$(dirname "\$0")" && pwd)"
AGENT_DIR="\$DIR/DevOpsAgent"
LOG_FILE="\$DIR/devops-agent.log"

# Ensure executable permissions
chmod +x "\$AGENT_DIR/bin/cs-devops-agent"

# If first arg is 'worker' or 'background', run in background
if [ "\$1" == "background" ]; then
  echo "Starting worker in background..."
  echo "--- Worker Start: \$(date) ---" >> "\$LOG_FILE"
  export AC_DEBUG="true"
  node "\$AGENT_DIR/src/cs-devops-agent-worker.js" >> "\$LOG_FILE" 2>&1 &
  echo "Worker PID: \$!"
  echo "Logs: \$LOG_FILE"
  exit 0
fi

# Otherwise run interactive CLI
node "\$AGENT_DIR/bin/cs-devops-agent" "\$@"
EOF

chmod +x "$RUNNER"

# Add to gitignore in target
GITIGNORE="$TARGET_DIR/.gitignore"
if [ -f "$GITIGNORE" ]; then
  if ! grep -q "DevOpsAgent/" "$GITIGNORE"; then
    echo "" >> "$GITIGNORE"
    echo "# DevOps Agent" >> "$GITIGNORE"
    echo "DevOpsAgent/" >> "$GITIGNORE"
    echo "devops-agent.log" >> "$GITIGNORE"
    echo "devops" >> "$GITIGNORE"
    echo "Added DevOpsAgent files to .gitignore"
  fi
fi

echo "Deployment complete!"
echo "Use the './devops' script to interact with the agent:"
echo ""
echo "  ./devops setup        # Run first-time setup"
echo "  ./devops chat         # Chat with Kora"
echo "  ./devops start        # Start session manager (Interactive)"
echo "  ./devops background   # Run worker silently"
echo "  ./devops --help       # See all commands"
echo ""
echo "Logs location: '$LOG_FILE'"
