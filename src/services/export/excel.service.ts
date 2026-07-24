import ExcelJS from 'exceljs';

// Google Play review text routinely contains control characters (NUL and other
// C0 controls) that are ILLEGAL in XML 1.0 — and an .xlsx is XML inside a zip.
// Left in, they produce a workbook Microsoft Excel refuses to open ("file format
// is not valid") even though the bytes are otherwise a valid zip. Strip every
// codepoint XML 1.0 forbids while keeping tab/newline/CR and everything from
// U+0020 up (emoji included). See https://www.w3.org/TR/xml/#charsets
function xmlSafe(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const allowed =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    if (allowed) out += ch;
  }
  return out;
}

// Only the fields the workbook actually renders — so the export endpoint can be
// stateless and accept the review data directly from the client.
export interface ExcelAppSummary {
  title: string;
  developer: string;
  category: string;
  version: string;
  installs: string;
  score: number;
  ratings: number;
}

export interface ExcelReviewRow {
  userName: string;
  score: number;
  text: string;
  date: string;
  version: string | null;
  thumbsUp: number;
  replyText: string | null;
  language: string;
}

export async function buildReviewsWorkbook(
  app: ExcelAppSummary,
  reviews: ExcelReviewRow[],
): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PlayReview AI';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Reviews', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'Username', key: 'userName', width: 24 },
    { header: 'Rating', key: 'score', width: 10 },
    { header: 'Review', key: 'text', width: 70 },
    { header: 'Date', key: 'date', width: 20 },
    { header: 'Version', key: 'version', width: 14 },
    { header: 'Helpful Count', key: 'thumbsUp', width: 14 },
    { header: 'Developer Reply', key: 'replyText', width: 50 },
    { header: 'Language', key: 'language', width: 14 },
  ];

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF3B82F6' },
  };
  sheet.getRow(1).alignment = { vertical: 'middle' };
  sheet.autoFilter = { from: 'A1', to: 'H1' };

  for (const r of reviews) {
    sheet.addRow({
      userName: xmlSafe(r.userName),
      score: r.score,
      text: xmlSafe(r.text),
      date: new Date(r.date).toLocaleString(),
      version: xmlSafe(r.version ?? '-'),
      thumbsUp: r.thumbsUp,
      replyText: xmlSafe(r.replyText ?? ''),
      language: xmlSafe(r.language),
    });
  }

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
  });

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 50 },
  ];
  summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF3B82F6' },
  };
  summarySheet.addRows([
    { field: 'App Name', value: xmlSafe(app.title) },
    { field: 'Developer', value: xmlSafe(app.developer) },
    { field: 'Category', value: xmlSafe(app.category) },
    { field: 'Current Version', value: xmlSafe(app.version) },
    { field: 'Installs', value: xmlSafe(app.installs) },
    { field: 'Average Rating', value: app.score },
    { field: 'Total Ratings', value: app.ratings },
    { field: 'Total Reviews Exported', value: reviews.length },
    { field: 'Exported At', value: new Date().toLocaleString() },
  ]);

  return workbook.xlsx.writeBuffer();
}
