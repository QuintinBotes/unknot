// The state contract of Unknot's mod (hooks/register.tsx): what the campaign panel draws from.

/** What `unknot status --json` prints, as far as the panel reads it. */
export type UnknotStatus = {
  mode?: string;
  config_acceptance?: string;
  active_run?: { id: string; command: string; slice?: string | null } | null;
  graph?: { stale?: boolean; head?: string | null; mapped_commit?: string | null };
  campaigns?: { id: string; status: string; objective?: string }[];
  slices?: { id: string; campaign_id: string | null; state: string; risk?: string }[];
  blockers?: { id: string; state: string }[];
  awaiting_approval?: string[];
  stale_evidence?: { expired_runtime_facts?: number; slices?: { slice_id: string }[] };
  for_you?: { heading?: string; steps?: { step: string; slice?: string; commands: string[]; note?: string }[] };
};

/** The panel's view: the last good status, and what the last refresh came to. */
export type UnknotPanel = {
  status: UnknotStatus | null;
  /** When `status` was read, ISO time. */
  at: string | null;
  /** The last refresh's failure; `status` is then the last good one, stale. */
  error: string | null;
  isUninitialised: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    unknot: { panel: Shaped<UnknotPanel> };
  }
}
