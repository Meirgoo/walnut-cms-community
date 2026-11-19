import type { WalnutPlugin } from '../types';
import { articlePlugin } from './article.plugin';
import { pagePlugin } from './page.plugin';
import { microPlugin } from './micro-content.plugin';
import { datasetPlugin } from './dataset.plugin';
import { themePlugin } from './theme.plugin';
import { SystemServicePlugin } from './system.plugin';
import { taskPlugin } from './task.plugin';
import { seoPlugin } from './seo.plugin';
import { ContentPorterPlugin } from './content-porter.plugin';
import { webhookCorePlugin } from './webhook.plugin';
import { ecosystemBridgePlugin } from './ecosystem-bridge.plugin';

export * from './common.helper';
export * from './article.plugin';
export * from './page.plugin';
export * from './micro-content.plugin';
export * from './dataset.plugin';
export * from './theme.plugin';
export * from './system.plugin';
export * from './task.plugin';
export * from './seo.plugin';
export * from './content-porter.plugin';
export * from './webhook.plugin';
export * from './ecosystem-bridge.plugin';
export * from './theme-repo';

export const coreServicePlugins: WalnutPlugin[] = [
    articlePlugin,
    pagePlugin,
    microPlugin,
    datasetPlugin,
    themePlugin,
    SystemServicePlugin,
    taskPlugin,
    seoPlugin,
    ContentPorterPlugin,
    webhookCorePlugin,
    ecosystemBridgePlugin
];
