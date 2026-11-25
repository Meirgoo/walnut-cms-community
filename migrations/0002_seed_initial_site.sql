-- Walnut CMS - Default Site & System Seeding
-- Provides baseline site, metadata, and default configuration

-- 1. 系统版本与初始未安装状态 (完成 setup 向导后激活为 true)
INSERT INTO system_meta (key, value) VALUES ('installed', 'false')
ON CONFLICT(key) DO NOTHING;

INSERT INTO system_meta (key, value) VALUES ('schema_version', '0.9.1')
ON CONFLICT(key) DO UPDATE SET value = '0.9.1', updated_at = CURRENT_TIMESTAMP;

-- 1.1 社区版默认粘性白标印章 (源码零硬编码品牌词，无商业 Key 时通过白标管道自然呈现)
INSERT INTO system_meta (key, value) VALUES ('oem_seal', '{"tier":"community","brand_name":"Walnut Edge CMS"}')
ON CONFLICT(key) DO NOTHING;

-- 2. 默认站点 (初始 primary_domain 为 '*' 通配待认领态，支持首访自动认领与零配置直出)
INSERT INTO sites (id, name, primary_domain, default_locale, theme_id, settings, robots_txt, status)
VALUES (
    'site_default',
    'Walnut Starter',
    '*',
    'zh-CN',
    'theme_univers',
    '{"site_name":"Walnut Starter","description":"轻量级边缘原生内容与页面装配站点","primary_color":"#342E7A","primary_color_dark":"#8B7CF6","theme_mode":"system","seo":{"keywords":["Walnut","Edge","Walnut Edge CMS","CMS","Starter"]}}',
    'User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/

Sitemap: /sitemap.xml',
    'active'
)
ON CONFLICT(id) DO NOTHING;
