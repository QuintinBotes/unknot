// The error model (spec §25). Every failure the runtime reports crosses a process or
// model boundary as this one JSON shape, so callers branch on `code`, never on prose.

export const ERROR_CLASSES = Object.freeze({
  UK_CONFIG_INVALID: { class: 'configuration', retryable: false },
  UK_ADAPTER_UNSUPPORTED: { class: 'adapter-unsupported', retryable: false },
  UK_BASELINE_INVALID: { class: 'baseline-invalid', retryable: false },
  UK_SCOPE_VIOLATION: { class: 'scope-violation', retryable: false },
  UK_POLICY_DENIED: { class: 'policy-denied', retryable: false },
  UK_APPROVAL_STALE: { class: 'approval-stale', retryable: false },
  UK_APPROVAL_REQUIRED: { class: 'policy-denied', retryable: false },
  UK_BUDGET_EXCEEDED: { class: 'budget-exceeded', retryable: false },
  UK_TOOL_FAILED: { class: 'tool-execution-failed', retryable: true },
  UK_EVIDENCE_INCONCLUSIVE: { class: 'evidence-inconclusive', retryable: true },
  UK_VERIFICATION_FAILED: { class: 'verification-failed', retryable: false },
  UK_STATE_CONFLICT: { class: 'state-conflict', retryable: true },
  UK_RECOVERY_REQUIRED: { class: 'recovery-required', retryable: false },
  UK_SCHEMA_INVALID: { class: 'configuration', retryable: false },
  UK_NOT_FOUND: { class: 'configuration', retryable: false },
  UK_NOT_INITIALIZED: { class: 'configuration', retryable: false },
  UK_INTEGRITY: { class: 'recovery-required', retryable: false },
});

export class UnknotError extends Error {
  /**
   * @param {keyof typeof ERROR_CLASSES} code
   * @param {string} message
   * @param {{run_id?: string, slice_id?: string, details?: object, retryable?: boolean, cause?: unknown}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause ? { cause: extra.cause } : undefined);
    if (!ERROR_CLASSES[code]) throw new TypeError(`unknown error code ${code}`);
    this.name = 'UnknotError';
    this.code = code;
    this.run_id = extra.run_id ?? null;
    this.slice_id = extra.slice_id ?? null;
    this.retryable = extra.retryable ?? ERROR_CLASSES[code].retryable;
    this.details = extra.details ?? {};
  }

  toJSON() {
    return {
      code: this.code,
      class: ERROR_CLASSES[this.code].class,
      message: this.message,
      run_id: this.run_id,
      slice_id: this.slice_id,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/** Normalise anything thrown into the structured shape, without leaking stack traces. */
export function toErrorJSON(err) {
  if (err instanceof UnknotError) return err.toJSON();
  return {
    code: 'UK_TOOL_FAILED',
    class: 'tool-execution-failed',
    message: String(err?.message ?? err),
    run_id: null,
    slice_id: null,
    retryable: false,
    details: {},
  };
}

export const fail = (code, message, extra) => {
  throw new UnknotError(code, message, extra);
};
