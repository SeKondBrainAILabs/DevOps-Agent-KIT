# Code Studio CS_DevOpsAgent Agent - Project Information

## Repository Details

- **GitHub Repository**: https://github.com/SecondBrainAICo/CS_DevOpsAgent
- **Organization**: SeKondBrain AI

## Project Structure

```
CS_DevOpsAgent/
├── src/                   # Source code files
│   ├── cs-devops-agent-worker.js    # Main worker
│   ├── setup-cs-devops-agent.js     # Setup wizard
│   ├── worktree-manager.js          # Agent isolation
│   └── run-with-agent.js            # Agent runner
├── docs/                  # Documentation
│   ├── PROJECT_INFO.md    # This file
│   ├── TESTING.md         # Test guide
│   └── infrastructure.md  # Change tracking
├── test_scripts/         # Test scripts
├── test_cases/          # Jest test cases
├── deploy_test/         # Deployment tests
├── package.json         # NPM configuration
├── LICENSE              # MIT License
├── README.md            # Main documentation
└── .gitignore          # Git ignore rules
```

## Key Features

- **Automatic Git Commits**: Watches for file changes and commit messages
- **Daily Branching**: Creates daily development branches (dev_{initials}_YYYY-MM-DD)
- **Version Management**: Micro-revision versioning (v0.20, v0.21, etc.)
- **VS Code Integration**: Tasks and settings for seamless workflow
- **Developer Personalization**: Each developer gets their own branch prefix
- **Claude AI Integration**: Generates CLAUDE.md house rules for AI assistance

## Quick Commands

### Setup (for new projects)
```bash
# Clone to a new project
git clone https://github.com/secondbrainAI-limited/code_studio_cs-devops-agentAgent.git CS_DevOpsAgent
cd CS_DevOpsAgent
./quick-start.sh
```

### Daily Usage
```bash
# Start the worker
npm run cs-devops-agent

# Create a commit message
echo "feat(module): description" > .claude-commit-msg

# Stop the worker
pkill -f "node.*cs-devops-agent-worker"
```

## Git Commands

### Push to GitHub
```bash
git push -u origin main
```

### Pull Latest Changes
```bash
git pull origin main
```

### Check Remote Status
```bash
git remote -v
git branch -vv
```

## Environment Variables

The system uses these environment variables (set during setup):

- `AC_BRANCH_PREFIX`: Developer's branch prefix (e.g., dev_sdd_)
- `AC_TZ`: Timezone for daily rollover (default: Asia/Dubai)
- `AC_PUSH`: Auto-push to remote (default: true)
- `AC_DEBUG`: Enable debug logging (default: false)

## Development Workflow

1. **Initial Setup**: Run `./quick-start.sh` in your project root
2. **Start Worker**: `npm run cs-devops-agent`
3. **Make Changes**: Edit your files normally
4. **Commit**: Write message to `.claude-commit-msg`
5. **Auto-Process**: Worker stages, commits, and pushes automatically
6. **Daily Rollover**: Handled automatically at midnight

## Integration with SeKondBrain Projects

This cs-devops-agent system is designed to work seamlessly with:
- SeKondBrain MVPEmails
- DistilledConceptExtractor
- Other SeKondBrain Code Studio projects

## Support

- **Issues**: https://github.com/secondbrainAI-limited/code_studio_cs-devops-agentAgent/issues
- **Organization**: https://github.com/secondbrainAI-limited

## License

MIT License - See LICENSE file for details

---

*Last Updated: 2025-09-25*