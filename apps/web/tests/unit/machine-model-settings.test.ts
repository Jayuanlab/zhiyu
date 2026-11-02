import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readMachineModelSettings,
  saveMachineModelSettings,
} from '@/lib/ai/machine-model-settings';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhiyu-model-fixture-'));
  await writeFile(
    join(root, '.env'),
    'OTHER_SETTING="preserve"\nOPENAI_API_KEY="private-audio-key"\nOPENAI_AUDIO_BASE_URL="https://audio.invalid/v1"\n',
  );
});
afterEach(async () => {
  if (root && root.startsWith(join(tmpdir(), 'zhiyu-model-fixture-')))
    await rm(root, { recursive: true, force: true });
});
describe('machine model file boundary', () => {
  it('never returns a saved credential', async () => {
    const data = await readMachineModelSettings(true, root);
    expect(JSON.stringify(data)).not.toContain('private-audio-key');
    expect(data.fields.find((f) => f.key === 'OPENAI_API_KEY')?.hasValue).toBe(
      true,
    );
  });
  it('preserves unrelated config, backs up changes and reports pending restart', async () => {
    const before = await readMachineModelSettings(true, root);
    const next = await saveMachineModelSettings(
      {
        expectedRevision: before.revision,
        updates: { LLM_EMBEDDING_MODEL: 'fixture-model' },
        actor: 'fixture-owner',
      },
      root,
    );
    expect(next.pendingRestart).toBe(true);
    expect(await readFile(join(root, '.env'), 'utf8')).toContain(
      'OTHER_SETTING="preserve"',
    );
    expect(
      (await readdir(join(root, '.runtime', 'model-config'))).filter((f) =>
        f.endsWith('.before.env'),
      ),
    ).toHaveLength(1);
  });
  it('rejects stale writers without replacing the file', async () => {
    const before = await readMachineModelSettings(true, root);
    await writeFile(join(root, '.env'), 'EXTERNAL_EDIT=yes\n');
    await expect(
      saveMachineModelSettings(
        {
          expectedRevision: before.revision,
          updates: { OPENAI_API_KEY: 'next' },
          actor: 'fixture',
        },
        root,
      ),
    ).rejects.toThrow('configuration_conflict');
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(
      'EXTERNAL_EDIT=yes\n',
    );
  });
  it('denies fields outside the whitelist and newline injection', async () => {
    const before = await readMachineModelSettings(true, root);
    for (const updates of [
      { AUTH_MODE: 'local_owner' },
      { OPENAI_API_KEY: 'bad\nAUTH_MODE=local_owner' },
    ] as Array<Record<string, string | null>>)
      await expect(
        saveMachineModelSettings(
          { expectedRevision: before.revision, updates, actor: 'fixture' },
          root,
        ),
      ).rejects.toThrow();
  });
  it('requires a new secret for a changed service address', async () => {
    const before = await readMachineModelSettings(true, root);
    await expect(
      saveMachineModelSettings(
        {
          expectedRevision: before.revision,
          updates: { OPENAI_AUDIO_BASE_URL: 'https://other.invalid/v1' },
          actor: 'fixture',
        },
        root,
      ),
    ).rejects.toThrow('host_change_requires_key');
  });
  it('retains empty passwords and clears only explicit null', async () => {
    let before = await readMachineModelSettings(true, root);
    await saveMachineModelSettings(
      {
        expectedRevision: before.revision,
        updates: { OPENAI_API_KEY: '' },
        actor: 'fixture',
      },
      root,
    );
    expect(await readFile(join(root, '.env'), 'utf8')).toContain(
      'private-audio-key',
    );
    before = await readMachineModelSettings(true, root);
    await saveMachineModelSettings(
      {
        expectedRevision: before.revision,
        updates: { OPENAI_API_KEY: null },
        actor: 'fixture',
      },
      root,
    );
    expect(await readFile(join(root, '.env'), 'utf8')).not.toContain(
      'private-audio-key',
    );
  });
  it('exposes and blocks overriding environment files', async () => {
    await writeFile(
      join(root, '.env.local'),
      'LLM_EMBEDDING_MODEL=higher-priority\n',
    );
    const before = await readMachineModelSettings(true, root);
    expect(
      before.fields.find((f) => f.key === 'LLM_EMBEDDING_MODEL')?.overriddenBy,
    ).toBe('.env.local');
    await expect(
      saveMachineModelSettings(
        {
          expectedRevision: before.revision,
          updates: { LLM_EMBEDDING_MODEL: 'unused' },
          actor: 'fixture',
        },
        root,
      ),
    ).rejects.toThrow('machine_field_overridden');
  });
});
