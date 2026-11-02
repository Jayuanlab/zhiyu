import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { z } from 'zod';
import { convertWorkshopDocumentToMarkdown } from '@/lib/workshops/document-markdown';
import { DayError, type Source } from './contracts';
import { dayTransaction, failDayCommand } from './store';
const requestSchema = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(180)
      .refine((n) => !/[\u0000-\u001f\\/]/.test(n)),
    bytesHash: z.string().length(64),
    operation: z.literal('source_upload'),
  })
  .strict();
export async function uploadDaySource(
  owner: string,
  input: { commandId: string; expectedRevision: number; name: string },
  bytes: Uint8Array,
) {
  if (!bytes.length || bytes.length > 5 * 1024 * 1024)
    throw new DayError('source_size_limit');
  const extension = extname(input.name).toLowerCase();
  if (!['.md', '.txt', '.pdf', '.docx', '.epub'].includes(extension))
    throw new DayError('source_format_unsupported');
  const command = requestSchema.parse({
    ...input,
    bytesHash: createHash('sha256').update(bytes).digest('hex'),
    operation: 'source_upload',
  });
  const reserved = await dayTransaction(
    owner,
    command,
    (snapshot) => {
      if (snapshot.sources.length >= 50)
        throw new DayError('source_count_limit');
      return { result: {} };
    },
    { reserve: true },
  );
  if (reserved.replayed) return reserved;
  const parent = resolve(process.cwd(), '.runtime', 'personal-day-import');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, 'import-'));
  let source: Source = {
    id: randomUUID(),
    name: input.name,
    hash: command.bytesHash,
    format: extension,
    status: 'review',
    text: '',
    principles: [],
    createdAt: new Date().toISOString(),
    warnings: [],
    originalBase64: Buffer.from(bytes).toString('base64'),
  };
  try {
    await mkdir(join(root, 'inputs'));
    await writeFile(join(root, 'inputs', 'source' + extension), bytes, {
      mode: 0o600,
    });
    try {
      const result = await convertWorkshopDocumentToMarkdown({
        runDir: root,
        inputPath: 'inputs/source' + extension,
        sourceId: source.id,
        originalName: input.name,
      });
      source.text = await readFile(result.documentPath, 'utf8');
      source.warnings = result.warnings;
      if (source.text.length > 100000) throw new DayError('source_text_limit');
    } catch (error) {
      source = {
        ...source,
        status: 'failed',
        text: '',
        error:
          error instanceof DayError ? error.code : 'source_conversion_failed',
        warnings: ['文件未转为可使用资料；扫描 PDF 或图片内容可能需要 OCR。'],
      };
    }
    return await dayTransaction(
      owner,
      command,
      () => ({
        sources: [source],
        event: {
          kind: 'source_uploaded',
          payload: {
            sourceId: source.id,
            name: source.name,
            hash: source.hash,
            status: source.status,
          },
        },
        result: { sourceId: source.id, status: source.status },
      }),
      { finish: true },
    );
  } catch (error) {
    await failDayCommand(
      owner,
      command.commandId,
      error instanceof DayError ? error.code : 'source_import_failed',
    );
    throw error;
  } finally {
    const actual = await realpath(root),
      allowed = await realpath(parent);
    if (!actual.startsWith(allowed + '\\') && !actual.startsWith(allowed + '/'))
      throw new DayError('source_cleanup_denied', 500);
    await rm(actual, { recursive: true, force: true });
  }
}
