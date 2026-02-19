# Prompts & AI Modes Contract

**Last Updated:** 2026-02-19
**Version:** 1.0.0
**Status:** Initial Template

---

## Purpose

This contract documents **all prompt templates, AI mode configurations, skill configs, and mode YAML files** in the project. Coding agents **MUST check this file before creating new prompts or modes** to:
- Reuse existing prompt templates instead of duplicating
- Maintain consistent prompt engineering patterns
- Avoid conflicting AI mode configurations
- Ensure prompt versioning and backward compatibility
- Track which services consume which prompts

---

## Change Log

| Date | Version | Agent/Author | Changes | Impact |
|------|---------|--------------|---------|--------|
| 2026-02-19 | 1.0.0 | DevOps Agent | Initial template creation | N/A - Template only |

---

## AI Modes Overview

### Mode Configuration Files

**Location:** `electron/config/modes/`

| Mode File | Mode Name | Purpose | Status |
|-----------|-----------|---------|--------|
| `[mode-name].yaml` | [Display Name] | [What this mode does] | Active/Beta/Deprecated |

### Mode YAML Schema

Each mode YAML file follows this structure:

```yaml
name: "[Mode Display Name]"
description: "[Short description of what this mode does]"
systemPrompt: |
  [The system prompt that shapes AI behavior in this mode]
temperature: [0.0-1.0]
maxTokens: [number]
model: "[model-name]"
capabilities:
  - [capability-1]
  - [capability-2]
tools:
  - [tool-name-1]
  - [tool-name-2]
```

---

## Prompt Templates

### Template Registry

| Template ID | Name | Used By | Purpose | Status |
|-------------|------|---------|---------|--------|
| [PT-001] | [Template Name] | [Service/Feature] | [What it generates] | Active |

### Prompt Template Format

#### Template ID: [PT-XXX] - [Template Name]

**Added:** [YYYY-MM-DD]
**Last Modified:** [YYYY-MM-DD]
**Status:** `active` | `deprecated` | `beta`
**Version:** [X.Y.Z]

**Description:**
[What this prompt template does and when it's used]

**Used By:**
- `[ServiceName]` — [how/when it uses this template]
- `[ComponentName]` — [how/when it uses this template]

**Input Variables:**

| Variable | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `{variable_name}` | string | YES | [What this variable contains] | [Example value] |

**Template:**

```
[The actual prompt template with {variable} placeholders]
```

**Output Format:**

```
[Expected output structure/format]
```

**Performance Notes:**
- Average token usage: [X] tokens
- Average response time: [X]s
- Model: [model-name]
- Temperature: [X]

**Example Usage:**

```typescript
const prompt = template.replace('{variable}', actualValue);
const result = await aiService.generate(prompt);
```

---

## Example Templates

<!-- ======================================================================= -->
<!-- NOTE: The following are EXAMPLES. Replace with actual project prompts.   -->
<!-- ======================================================================= -->

### Template ID: PT-001 - Commit Message Generation

**Added:** 2026-02-19
**Status:** `active`
**Version:** 1.0.0

**Description:**
Generates a concise, meaningful commit message from a set of file diffs.

**Used By:**
- `CommitAnalysisService` — auto-generates commit messages for agent sessions

**Input Variables:**

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `{diff}` | string | YES | Git diff output of staged changes |
| `{context}` | string | NO | Additional context about what was being worked on |

**Template:**

```
Analyze the following git diff and generate a concise commit message following conventional commits format (feat/fix/refactor/docs/test/chore).

The commit message should:
- Start with the type prefix
- Have a brief subject line (max 72 chars)
- Optionally include a body explaining WHY the change was made

Diff:
{diff}

Additional context:
{context}
```

**Output Format:**

```
type(scope): subject line

Optional body explaining the motivation.
```

---

### Template ID: PT-002 - Contract Generation

**Added:** 2026-02-19
**Status:** `active`
**Version:** 1.0.0

**Description:**
Analyzes source code to generate contract documentation for a feature.

**Used By:**
- `ContractGenerationService` — generates feature contracts from code analysis

**Input Variables:**

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `{featureName}` | string | YES | Name of the feature being documented |
| `{sourceFiles}` | string | YES | Concatenated source file contents |
| `{existingContracts}` | string | NO | Existing contract content for context |

---

## Skill Configurations

### What Are Skills?

Skills are reusable AI capabilities that can be composed into modes. Each skill has:
- A name and description
- A system prompt fragment
- Input/output specifications
- Tool requirements

### Skill Registry

| Skill ID | Name | Description | Used By Modes |
|----------|------|-------------|---------------|
| [SK-001] | [Skill Name] | [What this skill does] | [Mode1, Mode2] |

### Skill File Location

**Location:** `electron/config/skills/` (if applicable)

---

## Prompt Engineering Guidelines

### Best Practices

1. **Be specific:** Clearly define the expected output format
2. **Provide examples:** Include few-shot examples for complex tasks
3. **Set constraints:** Specify length limits, format requirements
4. **Use system prompts:** For persistent behavior, use mode system prompts
5. **Version prompts:** Every prompt change should bump the version
6. **Test prompts:** Verify output quality before deploying

### Anti-Patterns

- Vague instructions ("make it good")
- Overly long prompts (>2000 tokens for system prompts)
- Hardcoded prompts in service code (use template files)
- Unversioned prompt changes
- No output format specification

### Token Budget Guidelines

| Use Case | Max Input | Max Output | Temperature |
|----------|-----------|------------|-------------|
| Commit messages | 4K tokens | 200 tokens | 0.3 |
| Contract generation | 8K tokens | 2K tokens | 0.2 |
| Code analysis | 8K tokens | 1K tokens | 0.1 |
| Creative/brainstorming | 2K tokens | 1K tokens | 0.7 |

---

## Notes for Coding Agents

### CRITICAL RULES:

1. **ALWAYS check this contract before creating new prompts**
2. **SEARCH for existing templates** that serve the same purpose
3. **REUSE existing prompts** — extend with variables, don't duplicate
4. **NEVER hardcode prompts** in service code — use template files
5. **VERSION every prompt change** — prompts are contracts too
6. **UPDATE this contract** after creating/modifying prompts
7. **DOCUMENT input variables** with types, examples, and constraints
8. **CROSS-REFERENCE:**
   - `electron/config/modes/` for AI mode YAML files
   - `FEATURES_CONTRACT.md` for features using AI prompts
   - `THIRD_PARTY_INTEGRATIONS.md` for AI service providers

### Workflow:

```
BEFORE creating a new prompt:

1. Read PROMPTS_CONTRACT.md
2. Search for existing templates by:
   - Purpose (commit generation, code analysis, etc.)
   - Used-by service
   - Input/output similarity
3. If similar template exists → reuse and extend
4. If creating new template:
   - Assign unique Template ID (PT-XXX)
   - Document all input variables
   - Specify output format
   - Add token budget
   - Test with sample inputs
   - Update this contract
5. Increment version and add changelog entry
```

---

## Initial Population Instructions

**For DevOps Agent / Coding Agents:**

1. **Scan for mode YAML files:**
   - List all files in `electron/config/modes/`
   - Document each mode's name, purpose, and system prompt summary

2. **Scan for prompt strings in services:**
   - Search for `systemPrompt`, `prompt`, `template` in service files
   - Search for string literals containing AI instructions
   - Extract and document as templates

3. **Scan for AI service calls:**
   - Search for `aiService.generate`, `aiService.stream`
   - Identify the prompts being passed
   - Document input/output patterns

4. **Catalog skill configs:**
   - Search for skill definitions
   - Document skill registry

**Search Patterns:**
- Mode files: `electron/config/modes/*.yaml`
- Prompt strings: `systemPrompt`, `prompt:`, `template`
- AI calls: `generate(`, `stream(`, `chat(`
- Skill files: `electron/config/skills/*`

---

*This contract is a living document. Update it with every prompt or mode change.*
