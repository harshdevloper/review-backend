import { Router } from 'express';
import { exportExcel, exportExcelBodySchema } from '../controllers/export.controller.js';
import { validateBody } from '../middleware/validateBody.js';

export const exportRouter = Router();

exportRouter.post('/excel', validateBody(exportExcelBodySchema), exportExcel);
