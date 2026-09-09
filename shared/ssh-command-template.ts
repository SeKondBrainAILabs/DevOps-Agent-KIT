/**
 * SSH command template — parameter substitution + secret masking (I1).
 *
 * Saved SSH commands look like:
 *   "docker logs --since 1h {service} | grep {user_email}"
 * where each `{name}` is a parameter the user fills in at run-time.
 *
 * Rules:
 *  - Only `{snake_case_name}` placeholders are substituted.
 *  - Missing params produce a list of placeholders the renderer can highlight.
 *  - Values can be flagged as `secret: true`; in that case the rendered
 *    command for *display / logging* shows them masked, while the
 *    `commandToRun` still contains the real value. Audit logs use the
 *    masked form.
 */

const PLACEHOLDER_RE = /\{([a-z][a-z0-9_]*)\}/g;

export interface ParamValue {
  /** Real value sent to the shell. */
  value: string;
  /** When true, mask the value in display + audit logs. */
  secret?: boolean;
}

export interface SshTemplateInputs {
  template: string;
  params: Record<string, ParamValue | string>;
}

export interface SshTemplateResult {
  ok: boolean;
  /** Rendered command with secrets in plaintext — for execution. */
  commandToRun: string;
  /** Same render with secrets replaced by *** — for display + audit. */
  commandForDisplay: string;
  /** Placeholder names that had no value supplied. */
  missing: string[];
  /** Parameters declared but never referenced by the template (for warnings). */
  unused: string[];
  message?: string;
}

function asValue(v: ParamValue | string): ParamValue {
  return typeof v === 'string' ? { value: v } : v;
}

export function listPlaceholders(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    seen.add(m[1]);
  }
  return Array.from(seen);
}

export function renderSshCommand(input: SshTemplateInputs): SshTemplateResult {
  const placeholders = listPlaceholders(input.template);
  const provided = new Set(Object.keys(input.params));
  const missing = placeholders.filter((p) => !provided.has(p));
  const unused = Array.from(provided).filter((p) => !placeholders.includes(p));

  if (missing.length > 0) {
    return {
      ok: false,
      commandToRun: input.template,
      commandForDisplay: input.template,
      missing,
      unused,
      message:
        `Missing parameter${missing.length === 1 ? '' : 's'}: ` +
        missing.map((m) => `{${m}}`).join(', '),
    };
  }

  let commandToRun = input.template;
  let commandForDisplay = input.template;
  for (const name of placeholders) {
    const pv = asValue(input.params[name]);
    const re = new RegExp(`\\{${name}\\}`, 'g');
    commandToRun = commandToRun.replace(re, pv.value);
    commandForDisplay = commandForDisplay.replace(re, pv.secret ? '***' : pv.value);
  }

  return {
    ok: true,
    commandToRun,
    commandForDisplay,
    missing: [],
    unused,
  };
}

/** Convenience: mask any secret-looking substrings in arbitrary output (best-effort). */
export function maskKnownSecrets(s: string, secrets: ReadonlyArray<string>): string {
  let out = s;
  for (const sec of secrets) {
    if (!sec) continue;
    out = out.split(sec).join('***');
  }
  return out;
}
