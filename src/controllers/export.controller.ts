import type { Request, Response } from 'express';
import { z } from 'zod';
import { buildReviewsWorkbook } from '../services/export/excel.service.js';

const appSummarySchema = z.object({
  title: z.string(),
  developer: z.string(),
  category: z.string(),
  version: z.string(),
  installs: z.string(),
  score: z.number(),
  ratings: z.number(),
});

const reviewRowSchema = z.object({
  userName: z.string(),
  score: z.number(),
  text: z.string(),
  date: z.string(),
  version: z.string().nullable().default(null),
  thumbsUp: z.number(),
  replyText: z.string().nullable().default(null),
  language: z.string(),
});

// Stateless: the client sends the reviews it already has, so the export never
// depends on the server-side cache (which would 404 after a restart or TTL expiry).
export const exportExcelBodySchema = z.object({
  app: appSummarySchema,
  reviews: z.array(reviewRowSchema).min(1, 'No reviews to export.'),
});

type ExportBody = z.infer<typeof exportExcelBodySchema>;

export async function exportExcel(req: Request, res: Response): Promise<void> {
  const { app, reviews } = req.body as ExportBody;

  const workbookBuffer = await buildReviewsWorkbook(app, reviews);
  // ExcelJS types its output as its own Buffer type; at runtime it is a Node
  // Buffer (a Uint8Array), so normalise through Uint8Array for a clean copy.
  const bytes = Buffer.from(workbookBuffer as unknown as Uint8Array);
  const fileName = `${app.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '') || 'reviews'}-reviews.xlsx`;

  res.status(200);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', bytes.byteLength);
  // never let the compression middleware transform the binary payload
  res.setHeader('Cache-Control', 'no-transform');
  res.end(bytes);
}
