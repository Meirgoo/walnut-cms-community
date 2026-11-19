import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import { handleMediaUpload } from '../../engine';

export const uploadRouter = new Hono<AppHonoEnv>();

uploadRouter.post('/', handleMediaUpload);
