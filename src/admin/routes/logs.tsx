import { Hono } from 'hono';
import type { AppHonoEnv, AuditLogRowWithUser } from '../../engine';

export type AuditLogRow = AuditLogRowWithUser;

const logsRouter = new Hono<AppHonoEnv>();

logsRouter.get('/', (c) => c.redirect('/admin/audit?tab=logs', 302));

export { logsRouter };

