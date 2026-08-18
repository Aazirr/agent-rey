import type { PermissionMode } from '@agent-rey/shared';

/**
 * Permission modes, described in terms of consequence rather than jargon.
 *
 * `default` is first and is what the New Session sheet starts on — an unattended
 * mode must be a deliberate pick every time, never a value you land on by
 * accepting the form as-is (docs/decisions.md D-004).
 */
export const PERMISSION_MODES: ReadonlyArray<{
  value: PermissionMode;
  label: string;
  blurb: string;
  unattended: boolean;
}> = [
  {
    value: 'default',
    label: 'Ask me',
    blurb: 'Stops and waits for approval on anything risky. Safest, but it stalls when you look away.',
    unattended: false,
  },
  {
    value: 'plan',
    label: 'Plan only',
    blurb: 'Investigates and proposes, changes nothing. Good for thinking on the move.',
    unattended: false,
  },
  {
    value: 'acceptEdits',
    label: 'Edit files freely',
    blurb: 'Edits without asking, still prompts for commands. The usual choice for unattended work.',
    unattended: true,
  },
  {
    value: 'auto',
    label: 'Auto',
    blurb: 'Decides per action which prompts are worth surfacing.',
    unattended: false,
  },
  {
    value: 'dontAsk',
    label: "Don't ask",
    blurb: 'Suppresses prompts. Runs unsupervised in your real working tree.',
    unattended: true,
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass all checks',
    blurb: 'No permission checks at all, including shell commands. Use only when you mean it.',
    unattended: true,
  },
];

export function modeLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find((m) => m.value === mode)?.label ?? mode;
}
